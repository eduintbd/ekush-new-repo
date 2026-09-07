// Agent-raised lump-sum purchases.
//
// A selling agent may place a BUY on behalf of an investor they sourced. The
// rows land in the PORTAL's tables, so the order appears on
// portal.ekushwml.com/admin/approvals next to investor-raised ones and is
// approved by the same people through the same screen. This repo adds a new way
// to raise an order, not a second order system.
//
// Nothing in apps/portal changes, because three things there already work:
//
//   • Approving an ORDER already emails AND WhatsApps the investor
//     (api/admin/approvals/route.ts calls sendOrderApprovedEmail +
//     sendOrderApprovedWhatsApp). Order.emailConfirmedAt / whatsappConfirmedAt
//     stop a retry double-sending.
//   • The approval card already renders any ORDER row, and resolves
//     orders."paymentRef" through resolveSignedUrl("kyc-documents", ref) — the
//     same private bucket lib/kyc-upload.ts writes to.
//   • The admin investor page lists documents generically, so the client's
//     written instruction is visible there as an ordinary Document row.
//
// Follows the precedent of lib/agent-sip.ts: INSERT into public.* by raw SQL,
// never UPDATE or DELETE. Prisma has no models for the portal's schema
// (schemas = ["xsystem"]), so column names here are hand-kept in step with
// apps/portal/prisma/schema.prisma. They are camelCase and MUST stay quoted.
//
// Two decisions inherited from agent-sip.ts, for the same reasons:
//
//  • makerId is the INVESTOR's portal user id, not the agent. The agent has no
//    row in public.users at all, and the portal's gate is
//    `canApproveRequest(role, userId, approval.makerId)` which refuses when
//    checker === maker. Agent attribution rides in the queue note instead, as
//    `[Sales agent S00001]`.
//  • Validation is enforced here, server-side. The portal's own buy route
//    checks little because the investor is spending their own money; an agent
//    acting on someone else's behalf gets the rules checked where the browser
//    cannot skip them.

import { prisma } from "@/lib/prisma";
import { getAgentSourcedInvestors } from "@/lib/agent-sourced";

export type PurchaseFundOption = {
  id: string;
  code: string;
  name: string;
  /** Latest public.nav_records value. Null when the fund has no NAV history. */
  currentNav: number | null;
};

export type PurchaseInvestorOption = {
  investorCode: string;
  investorId: string;
  /** public.users.id — the maker on the approval row and the notified user. */
  userId: string | null;
  name: string;
  email: string | null;
  /** Why this investor is reachable: a commission link, or this agent onboarded them. */
  via: "linked" | "onboarded";
};

/**
 * The investors this agent may buy for.
 *
 * Deliberately WIDER than the SIP form's list. That one uses the AgentInvestor
 * links alone, which the nightly cron only creates once an investor has an
 * executed BUY — so it can never include somebody who has not yet bought, and
 * the single most common case for this flow is the first purchase right after
 * onboarding. The union with getAgentSourcedInvestors() (which reads the
 * sourcingAgentCode on the REGISTRATION KYC snapshot) covers exactly that gap.
 *
 * Both halves are already restricted to ACTIVE investors holding a real,
 * non-PENDING code, so an account still awaiting approval never appears.
 */
export async function listPurchaseInvestors(args: {
  agentCode: string;
  linkedCodes: string[];
}): Promise<PurchaseInvestorOption[]> {
  const onboarded = await getAgentSourcedInvestors(args.agentCode);
  const onboardedCodes = onboarded
    .filter((o) => o.status === "ACTIVE" && !o.investorCode.startsWith("PENDING-"))
    .map((o) => o.investorCode);

  const linkedSet = new Set(args.linkedCodes);
  const codes = Array.from(new Set([...args.linkedCodes, ...onboardedCodes]));
  if (codes.length === 0) return [];

  const rows = await prisma.$queryRawUnsafe<
    Array<{
      id: string;
      investorCode: string;
      name: string | null;
      userId: string | null;
      email: string | null;
      status: string | null;
    }>
  >(
    `SELECT i.id, i."investorCode", i.name, u.id AS "userId", u.email, u.status
       FROM public.investors i
       LEFT JOIN public.users u ON u.id = i."userId"
      WHERE i."investorCode" = ANY($1::text[])
        AND i."investorCode" NOT LIKE 'PENDING-%'
        AND u.status = 'ACTIVE'
      ORDER BY i."investorCode" ASC`,
    codes,
  );

  return rows.map((r) => ({
    investorCode: r.investorCode,
    investorId: r.id,
    userId: r.userId,
    name: r.name ?? "",
    email: r.email,
    via: linkedSet.has(r.investorCode) ? "linked" : "onboarded",
  }));
}

/**
 * Every fund an agent can buy into, priced off the LATEST public.nav_records
 * row.
 *
 * Deliberately not funds."currentNav": the portal documents that column as a
 * cache several write paths update, which silently drifted and froze the Ekush
 * Growth Fund's NAV at its 2022 inception value. This NAV prices the order and
 * is printed on the client's purchase form, so it comes from the record table.
 * Same basis as lib/portal-funds.ts and the portal's own getLatestNavForFund.
 */
export async function listPurchaseFunds(): Promise<PurchaseFundOption[]> {
  const funds = await prisma.$queryRawUnsafe<
    Array<{ id: string; code: string; name: string }>
  >(`SELECT id, code, name FROM public.funds ORDER BY code ASC`);

  return Promise.all(
    funds.map(async (f) => {
      const nav = await prisma.$queryRawUnsafe<Array<{ nav: unknown }>>(
        `SELECT nav FROM public.nav_records WHERE "fundId" = $1 ORDER BY date DESC LIMIT 1`,
        f.id,
      );
      return {
        id: f.id,
        code: f.code,
        name: f.name,
        currentNav: nav[0]?.nav != null ? Number(nav[0].nav) : null,
      };
    }),
  );
}

export class PurchaseValidationError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export type CreatePurchaseInput = {
  investorCode: string;
  fundCode: string;
  amount: number;
  agentCode: string;
  /** kyc-documents storage key for the investor's bank deposit slip. */
  paymentSlipPath: string;
  /** The client's written instruction to purchase. */
  instruction: { filePath: string; fileName: string; mimeType: string };
};

export type CreatePurchaseResult = {
  orderId: string;
  fundCode: string;
  fundName: string;
  amount: number;
  nav: number;
  estUnits: number;
  investorCode: string;
};

/**
 * Validate and write one BUY order, its approval-queue row, the investor's
 * notification and the instruction document — all or nothing.
 *
 * The order and its queue row must both exist or neither: an order with no
 * queue row is invisible to /admin/approvals and can never be approved. The
 * portal learned that the hard way with SIP plans (see agent-sip.ts).
 */
export async function createAgentPurchase(
  input: CreatePurchaseInput,
  allowedCodes: Set<string>,
): Promise<CreatePurchaseResult> {
  const { investorCode, fundCode, amount, agentCode } = input;

  // Ownership first — an agent may only ever act on an investor they sourced.
  if (!allowedCodes.has(investorCode)) {
    throw new PurchaseValidationError(403, `${investorCode} is not one of your investors.`);
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new PurchaseValidationError(400, "Enter a positive investment amount.");
  }
  if (!input.paymentSlipPath) {
    throw new PurchaseValidationError(400, "The bank deposit slip is required.");
  }
  if (!input.instruction?.filePath) {
    throw new PurchaseValidationError(
      400,
      "The client's written instruction to purchase is required.",
    );
  }

  const inv = (
    await prisma.$queryRawUnsafe<Array<{ id: string; userId: string | null; name: string | null }>>(
      `SELECT id, "userId", name FROM public.investors WHERE "investorCode" = $1 LIMIT 1`,
      investorCode,
    )
  )[0];
  if (!inv) throw new PurchaseValidationError(404, `Investor ${investorCode} not found.`);
  if (!inv.userId) {
    throw new PurchaseValidationError(
      409,
      `${investorCode} has no portal login yet, so the approval queue has nobody to attribute the order to. Ask the office to complete their account first.`,
    );
  }

  const f = (
    await prisma.$queryRawUnsafe<Array<{ id: string; code: string; name: string }>>(
      `SELECT id, code, name FROM public.funds WHERE code = $1 LIMIT 1`,
      fundCode,
    )
  )[0];
  if (!f) throw new PurchaseValidationError(404, `Fund ${fundCode} not found.`);

  // Price off the record table, never the cached column — see listPurchaseFunds.
  const navRow = await prisma.$queryRawUnsafe<Array<{ nav: unknown }>>(
    `SELECT nav FROM public.nav_records WHERE "fundId" = $1 ORDER BY date DESC LIMIT 1`,
    f.id,
  );
  const nav = navRow[0]?.nav != null ? Number(navRow[0].nav) : 0;
  if (!(nav > 0)) {
    throw new PurchaseValidationError(400, `No NAV is published for ${f.code} yet.`);
  }

  const estUnits = amount / nav;

  const orderId = await prisma.$transaction(async (tx) => {
    const created = await tx.$queryRawUnsafe<Array<{ id: string }>>(
      `INSERT INTO public.orders
         (id, "investorId", "fundId", channel, direction, amount, "estNav", "estUnits",
          "estAmount", "paymentMethod", "paymentRef", "makerId", status,
          "createdAt", "updatedAt")
       VALUES (gen_random_uuid()::text, $1, $2, 'LS', 'BUY', $3, $4, $5, $3,
               'BANK_TRANSFER', $6, $7, 'PENDING', now(), now())
       RETURNING id`,
      inv.id,
      f.id,
      amount,
      nav,
      estUnits,
      input.paymentSlipPath,
      inv.userId,
    );
    const id = created[0].id;

    await tx.$executeRawUnsafe(
      `INSERT INTO public.approval_queue
         (id, "entityType", "entityId", "makerId", status, notes, "createdAt", "updatedAt")
       VALUES (gen_random_uuid()::text, 'ORDER', $1, $2, 'PENDING', $3, now(), now())`,
      id,
      inv.userId,
      `BUY ${f.code} - BDT ${amount.toLocaleString("en-IN")} (${estUnits.toFixed(4)} units @ NAV ${nav.toFixed(4)}) [Sales agent ${agentCode}] - client's written instruction attached to the investor's documents`,
    );

    await tx.$executeRawUnsafe(
      `INSERT INTO public.notifications
         (id, "userId", type, title, message, "isRead", link, "createdAt")
       VALUES (gen_random_uuid()::text, $1, 'TRANSACTION', $2, $3, false, '/transactions', now())`,
      inv.userId,
      "Buy Order Placed",
      `A buy order for ${f.code} of BDT ${amount.toLocaleString("en-IN")} was submitted by your relationship manager (${agentCode}) and is awaiting approval.`,
    );

    // Filed against the investor so the portal admin sees it on their profile
    // — the approval card has only the one paymentRef slot, which carries the
    // deposit slip exactly as it does for investor-raised orders.
    await tx.$executeRawUnsafe(
      `INSERT INTO public.documents
         (id, "investorId", type, "fileName", "filePath", "mimeType", "createdAt")
       VALUES (gen_random_uuid()::text, $1, 'AGENT_PURCHASE_INSTRUCTION', $2, $3, $4, now())`,
      inv.id,
      input.instruction.fileName,
      input.instruction.filePath,
      input.instruction.mimeType,
    );

    return id;
  });

  return {
    orderId,
    fundCode: f.code,
    fundName: f.name,
    amount,
    nav,
    estUnits,
    investorCode,
  };
}
