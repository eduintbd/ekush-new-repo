// Agent-created SIP instructions.
//
// A selling agent may raise a SIP on behalf of an investor they sourced. The
// rows land in the PORTAL's tables, so the plan appears on
// portal.ekushwml.com/admin/approvals next to investor-raised ones and is
// approved by the same people through the same screen — this repo adds a new
// way to create a SIP, not a second SIP system.
//
// It follows the precedent already set by agent onboarding
// (src/app/api/agent/investors/create/route.ts) and agent-raised tickets
// (src/app/agent/investors/[code]/actions.ts): INSERT into public.* by raw SQL,
// never UPDATE or DELETE. Prisma has no models for the portal's schema
// (schemas = ["xsystem"]), so column names here are hand-kept in step with
// apps/portal/prisma/schema.prisma. They are camelCase and MUST stay quoted.
//
// Two decisions worth knowing:
//
//  • makerId is the INVESTOR's portal user id, not the agent. The agent has no
//    row in public.users at all, and the portal's approval gate is
//    `canApproveRequest(role, userId, approval.makerId)` which refuses when
//    checker === maker. Stamping anything else would either break the FK or
//    lock an admin out of approving. The WhatsApp bot resolves it the same way
//    (lib/wa-bot/router.ts confirmSip) — this is the established pattern for a
//    non-session actor creating a SIP. Agent attribution rides in the queue
//    notes instead, as `[Sales agent S00001]`, matching how agent-raised
//    service requests already tag themselves.
//
//  • Debit day may be ANY day 1–31. The portal offers only 5/15/26 and its
//    date helpers say so out loud; ours clamp. See src/lib/sip-dates.ts.

import { prisma } from "@/lib/prisma";
import {
  addYearsKeepingDay,
  clampDayToMonth,
  DEBIT_DAY_MAX,
  DEBIT_DAY_MIN,
  nextDebitDate,
  SIP_MIN_AMOUNT,
  TENURE_MAX,
  TENURE_MIN,
} from "@/lib/sip-dates";

export type SipFundOption = {
  id: string;
  code: string;
  name: string;
  currentNav: number | null;
  /** The fund's own configured SIP floor. 0 on every fund today, which is why
   *  the portal's page hardcodes 1000 instead — honoured here when someone
   *  actually sets it, so the two never disagree. */
  minSipAmount: number;
};

export type SipBankOption = {
  id: string;
  bankName: string;
  branchName: string | null;
  accountNumber: string;
  routingNumber: string | null;
  isPrimary: boolean;
  status: string;
};

export type SipInvestorOption = {
  investorCode: string;
  investorId: string;
  /** public.users.id — the maker on the approval row and the notified user. */
  userId: string | null;
  name: string;
  email: string | null;
  banks: SipBankOption[];
  /** Existing plans, so the form can warn before creating a duplicate. */
  existingSips: Array<{ fundCode: string; amount: number; status: string; debitDay: number }>;
};

/**
 * The investors this agent may raise a SIP for: exactly the ones on their
 * "My investors" list, i.e. those with an AgentInvestor link.
 *
 * That link is created by the nightly reconcile cron only once the investor is
 * ACTIVE, holds a real (non-PENDING) code, and has an executed BUY — so a
 * freshly onboarded investor will not appear here until they have invested.
 * That is deliberate: a SIP mandate cannot be honoured by the bank for an
 * account that has not completed KYC.
 */
export async function listSipInvestors(codes: string[]): Promise<SipInvestorOption[]> {
  if (codes.length === 0) return [];

  const investors = await prisma.$queryRawUnsafe<
    Array<{ id: string; investorCode: string; name: string | null; userId: string | null; email: string | null }>
  >(
    `SELECT i.id, i."investorCode", i.name, u.id AS "userId", u.email
       FROM public.investors i
       LEFT JOIN public.users u ON u.id = i."userId"
      WHERE i."investorCode" = ANY($1::text[])
      ORDER BY i."investorCode" ASC`,
    codes,
  );
  if (investors.length === 0) return [];

  const ids = investors.map((i) => i.id);
  const banks = await prisma.$queryRawUnsafe<
    Array<SipBankOption & { investorId: string }>
  >(
    `SELECT id, "investorId", "bankName", "branchName", "accountNumber",
            "routingNumber", "isPrimary", status
       FROM public.bank_accounts
      WHERE "investorId" = ANY($1::text[])
      ORDER BY "isPrimary" DESC, "createdAt" ASC`,
    ids,
  );
  const sips = await prisma.$queryRawUnsafe<
    Array<{ investorId: string; fundCode: string; amount: number; status: string; debitDay: number }>
  >(
    `SELECT s."investorId", f.code AS "fundCode", s.amount, s.status, s."debitDay"
       FROM public.sip_plans s
       JOIN public.funds f ON f.id = s."fundId"
      WHERE s."investorId" = ANY($1::text[])
        AND s.status IN ('ACTIVE', 'PENDING_APPROVAL', 'PAUSED')`,
    ids,
  );

  return investors.map((i) => ({
    investorCode: i.investorCode,
    investorId: i.id,
    userId: i.userId,
    name: i.name ?? "",
    email: i.email,
    banks: banks.filter((b) => b.investorId === i.id).map(({ investorId: _drop, ...b }) => b),
    existingSips: sips
      .filter((s) => s.investorId === i.id)
      .map((s) => ({
        fundCode: s.fundCode,
        amount: Number(s.amount),
        status: s.status,
        debitDay: Number(s.debitDay),
      })),
  }));
}

/** Every fund the investor could start a SIP into — the portal offers all of
 *  them on /sip, so the agent form does too. */
export async function listSipFunds(): Promise<SipFundOption[]> {
  const rows = await prisma.$queryRawUnsafe<
    Array<{ id: string; code: string; name: string; currentNav: unknown; minSipAmount: unknown }>
  >(
    `SELECT id, code, name, "currentNav", "minSipAmount"
       FROM public.funds
      ORDER BY code ASC`,
  );
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    currentNav: r.currentNav != null ? Number(r.currentNav) : null,
    minSipAmount: Number(r.minSipAmount ?? 0),
  }));
}

/** The floor that actually applies to a fund: its own configured minimum when
 *  set, otherwise the portal's standard 1,000. */
export function minAmountForFund(minSipAmount: number): number {
  return minSipAmount > 0 ? minSipAmount : SIP_MIN_AMOUNT;
}

export type CreateSipInput = {
  investorCode: string;
  fundCode: string;
  amount: number;
  tenure: number;
  debitDay: number;
  bankAccountId: string | null;
  agentCode: string;
};

export type CreateSipResult = {
  sipPlanId: string;
  startDate: Date;
  endDate: Date;
  debitDay: number;
};

export class SipValidationError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/**
 * Validate and write one SIP plan.
 *
 * Validation is enforced HERE, server-side, unlike the portal — its
 * POST /api/sip checks only `!fundCode || !amount || amount <= 0` and leaves
 * the minimum amount, the tenure bounds and the debit day to the browser. An
 * agent-facing endpoint takes instructions on someone else's behalf, so the
 * rules are checked where they cannot be skipped.
 */
export async function createAgentSip(
  input: CreateSipInput,
  allowedCodes: Set<string>,
): Promise<CreateSipResult> {
  const { investorCode, fundCode, amount, tenure, debitDay, bankAccountId, agentCode } = input;

  // Ownership first — an agent may only ever act on an investor they sourced.
  if (!allowedCodes.has(investorCode)) {
    throw new SipValidationError(403, `${investorCode} is not one of your investors.`);
  }
  const tenureYears = Math.trunc(Number(tenure));
  if (!Number.isFinite(tenureYears) || tenureYears < TENURE_MIN || tenureYears > TENURE_MAX) {
    throw new SipValidationError(400, `Tenure must be between ${TENURE_MIN} and ${TENURE_MAX} years.`);
  }
  const day = Math.trunc(Number(debitDay));
  if (!Number.isFinite(day) || day < DEBIT_DAY_MIN || day > DEBIT_DAY_MAX) {
    throw new SipValidationError(400, `Debit day must be between ${DEBIT_DAY_MIN} and ${DEBIT_DAY_MAX}.`);
  }

  const investor = await prisma.$queryRawUnsafe<
    Array<{ id: string; userId: string | null; name: string | null }>
  >(
    `SELECT id, "userId", name FROM public.investors WHERE "investorCode" = $1 LIMIT 1`,
    investorCode,
  );
  const inv = investor[0];
  if (!inv) throw new SipValidationError(404, `Investor ${investorCode} not found.`);
  if (!inv.userId) {
    throw new SipValidationError(
      409,
      `${investorCode} has no portal login yet, so the approval queue has nobody to attribute the request to. Ask the office to complete their account first.`,
    );
  }

  const fund = await prisma.$queryRawUnsafe<Array<{ id: string; code: string; minSipAmount: unknown }>>(
    `SELECT id, code, "minSipAmount" FROM public.funds WHERE code = $1 LIMIT 1`,
    fundCode,
  );
  const f = fund[0];
  if (!f) throw new SipValidationError(404, `Fund ${fundCode} not found.`);

  // Checked against the fund only after it resolves, so a per-fund floor is
  // honoured rather than a blanket one.
  const minAmount = minAmountForFund(Number(f.minSipAmount ?? 0));
  if (!Number.isFinite(amount) || amount < minAmount) {
    throw new SipValidationError(
      400,
      `Minimum monthly investment for ${f.code} is BDT ${minAmount.toLocaleString("en-IN")}.`,
    );
  }

  // A bank account must belong to THIS investor. The portal silently falls back
  // to null when it does not; here it is an error, because the agent picked it
  // from a list and a mismatch means something is wrong rather than missing.
  if (bankAccountId) {
    const owned = await prisma.$queryRawUnsafe<Array<{ id: string; status: string }>>(
      `SELECT id, status FROM public.bank_accounts WHERE id = $1 AND "investorId" = $2 LIMIT 1`,
      bankAccountId,
      inv.id,
    );
    if (owned.length === 0) {
      throw new SipValidationError(400, "That bank account does not belong to this investor.");
    }
  }

  const start = nextDebitDate(new Date(), day);
  const end = addYearsKeepingDay(start, tenureYears, day);

  // The plan and its approval row must both exist or neither: a plan with no
  // queue row is invisible to /admin/approvals and can never be activated. The
  // portal learned this the hard way — its own comment cites
  // scripts/diagnose-sip-coverage.ts "Category A" for exactly this drift.
  const sipPlanId = await prisma.$transaction(async (tx) => {
    const created = await tx.$queryRawUnsafe<Array<{ id: string }>>(
      `INSERT INTO public.sip_plans
         (id, "investorId", "fundId", "bankAccountId", amount, frequency, "debitDay",
          "startDate", "endDate", status, "createdAt", "updatedAt")
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, 'MONTHLY', $5, $6, $7,
               'PENDING_APPROVAL', now(), now())
       RETURNING id`,
      inv.id,
      f.id,
      bankAccountId,
      amount,
      day,
      start,
      end,
    );
    const id = created[0].id;

    await tx.$executeRawUnsafe(
      `INSERT INTO public.approval_queue
         (id, "entityType", "entityId", "makerId", status, notes, "createdAt", "updatedAt")
       VALUES (gen_random_uuid()::text, 'SIP_PLAN', $1, $2, 'PENDING', $3, now(), now())`,
      id,
      inv.userId,
      `SIP ${f.code} - BDT ${Number(amount).toLocaleString("en-IN")}/MONTHLY (debit ${day}) [Sales agent ${agentCode}]`,
    );

    await tx.$executeRawUnsafe(
      `INSERT INTO public.notifications
         (id, "userId", type, title, message, "isRead", link, "createdAt")
       VALUES (gen_random_uuid()::text, $1, 'SIP', $2, $3, false, '/sip', now())`,
      inv.userId,
      "SIP Plan Submitted",
      `A SIP of BDT ${Number(amount).toLocaleString("en-IN")} per month into ${f.code} was submitted by your relationship manager (${agentCode}) and is awaiting approval.`,
    );

    return id;
  });

  return { sipPlanId, startDate: start, endDate: end, debitDay: day };
}

/** Attach a new bank account to an investor, pending admin approval.
 *
 *  Mirrors the portal's inline add-bank on /sip: max two accounts, blocked
 *  while one is already awaiting approval, and the NID scan is mandatory so
 *  the admin can match the account-holder name before approving. */
export async function addInvestorBank(
  args: {
    investorCode: string;
    bankName: string;
    accountNumber: string;
    branchName: string | null;
    routingNumber: string | null;
    nidImageUrl: string;
    chequeLeafUrl: string | null;
    agentCode: string;
  },
  allowedCodes: Set<string>,
): Promise<{ bankAccountId: string }> {
  if (!allowedCodes.has(args.investorCode)) {
    throw new SipValidationError(403, `${args.investorCode} is not one of your investors.`);
  }
  if (!args.bankName.trim() || !args.accountNumber.trim()) {
    throw new SipValidationError(400, "Bank name and account number are required.");
  }
  if (!args.nidImageUrl) {
    throw new SipValidationError(400, "The investor's NID scan is required to add a bank account.");
  }

  const inv = (
    await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM public.investors WHERE "investorCode" = $1 LIMIT 1`,
      args.investorCode,
    )
  )[0];
  if (!inv) throw new SipValidationError(404, `Investor ${args.investorCode} not found.`);

  const existing = await prisma.$queryRawUnsafe<Array<{ status: string }>>(
    `SELECT status FROM public.bank_accounts WHERE "investorId" = $1`,
    inv.id,
  );
  if (existing.some((b) => b.status === "PENDING_APPROVAL")) {
    throw new SipValidationError(409, "This investor already has a bank account awaiting approval.");
  }
  if (existing.filter((b) => b.status !== "REJECTED").length >= 2) {
    throw new SipValidationError(409, "This investor already has the maximum of 2 registered bank accounts.");
  }

  const created = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `INSERT INTO public.bank_accounts
       (id, "investorId", "bankName", "branchName", "accountNumber", "routingNumber",
        "chequeLeafUrl", "nidImageUrl", "isPrimary", status, "createdAt", "updatedAt")
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, false,
             'PENDING_APPROVAL', now(), now())
     RETURNING id`,
    inv.id,
    args.bankName.trim(),
    args.branchName?.trim() || null,
    args.accountNumber.trim(),
    args.routingNumber?.trim() || null,
    args.chequeLeafUrl,
    args.nidImageUrl,
  );
  return { bankAccountId: created[0].id };
}

/** Which day the first debit actually falls on, for the confirmation screen. */
export function firstDebitPreview(debitDay: number): { date: Date; clampedDay: number } {
  const date = nextDebitDate(new Date(), debitDay);
  return { date, clampedDay: clampDayToMonth(date.getFullYear(), date.getMonth(), debitDay) };
}
