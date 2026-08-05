// Selling-agent commission payout — the two steps that take a computed
// commission and turn it into money out of the bank.
//
// Before this module, `commission_runs` was a dead end: rows were written as
// `accrued` and nothing ever wrote `paid_on`, `status='paid'` or a journal
// batch. Commission never reached the trial balance at all.
//
// The reason it is TWO steps and not one is that the billing date and the
// payment date are different days. The accountant bills to 30 Jul and the bank
// transfer goes out on 5 Aug. Posting a single voucher on the transfer date
// would put July's expense in August:
//
//   accrue → AC/<fy>/nnnn dated the billing period end
//              Dr Selling agent fees          gross
//              Cr Liab-Selling Agent Commission     gross
//
//   pay    → CP/<fy>/nnnn dated the day the transfer left
//              Dr Liab-Selling Agent Commission gross
//              Cr <bank account>                     net
//              Cr AIT & VAT Payble                   withheld
//
// Expense lands in July, cash leaves in August, and the payable carries the
// obligation across the boundary. The two vouchers can fall in different
// fiscal years; each is allocated a number in its own.
//
// Both steps are idempotent through the data, not through a flag: `accrue`
// only picks up runs with a null journal_batch_id, and `pay` only picks up
// runs that have one and are not yet paid. Clicking either button twice does
// nothing the second time.
//
// Follows the tax-provision precedent (src/app/admin/tax-provision/actions.ts):
// allocate the voucher number inside the same transaction as the createMany
// that consumes it, then stamp the domain rows with the batch id.

import { randomUUID } from "node:crypto";
import { prisma, withActor } from "@/lib/prisma";
import { allocateVoucherNo } from "@/lib/voucher";
import { ACCOUNT } from "@/lib/statement_mapping";

/** Expense leg — already on the IS as "Selling Agent Fee" (Note). */
const EXPENSE_ACCOUNT = ACCOUNT.sellingAgentFees;
/** Liability leg, cleared by the payment voucher. */
const PAYABLE_ACCOUNT = ACCOUNT.liabSellingAgentCommission;
/** Where tax deducted at source is parked until it is remitted to the NBR. */
const WITHHOLDING_ACCOUNT = ACCOUNT.aitAndVatPayable;

export type AccrualResult = {
  /** No un-accrued runs found — already accrued, or nothing computed yet. */
  noop: boolean;
  voucherNo: string;
  batchId: string;
  amount: number;
  runs: number;
  /** What the one voucher covered. `type` was already selected and never read,
   *  so the accountant could not see that upfront was inside the figure. */
  byType: { upfront: number; trail: number; clawback: number };
  /** Period the accrual covers, for the confirmation message. */
  periodStart: string | null;
  periodEnd: string;
};

/** "upfront 2,400.00 · trail 182.93" — zero types omitted. */
export function describeSplit(byType: {
  upfront: number;
  trail: number;
  clawback: number;
}): string {
  return (
    [
      ["upfront", byType.upfront],
      ["trail", byType.trail],
      ["clawback", byType.clawback],
    ] as const
  )
    .filter(([, v]) => v !== 0)
    .map(([k, v]) => `${k} ${v.toFixed(2)}`)
    .join(" · ");
}

export type PaymentResult = {
  /** Nothing accrued-and-unpaid up to the billing end. */
  noop: boolean;
  voucherNo: string;
  batchId: string;
  paymentId: string;
  gross: number;
  withholding: number;
  net: number;
  runs: number;
};

/** Money is Decimal(18,2) in the DB; keep JS arithmetic on the same grid. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Midnight UTC of a YYYY-MM-DD, which is how @db.Date round-trips. */
export function parseDateOnly(raw: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) return null;
  const d = new Date(`${raw.trim()}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Thrown for every refusal below so callers can surface the reason verbatim
 *  instead of guessing at an error code. */
export class PayoutError extends Error {}

/**
 * The fiscal year a voucher dated `on` belongs to. Resolved from the date
 * rather than asked for, because the whole point of this module is that the
 * accrual and the payment can sit in different years — making the accountant
 * pick one invites them to file both in the same one.
 */
async function fiscalYearFor(
  on: Date,
  what: string,
): Promise<{ id: string; label: string }> {
  const fy = await prisma.fiscalYear.findFirst({
    where: { startsOn: { lte: on }, endsOn: { gte: on } },
    select: { id: true, label: true, isClosed: true },
  });
  if (!fy) {
    throw new PayoutError(
      `No fiscal year covers ${ymd(on)} — create it under Admin → Fiscal years before posting the ${what}.`,
    );
  }
  if (fy.isClosed) {
    throw new PayoutError(
      `${fy.label} is closed; the ${what} dated ${ymd(on)} cannot be posted into it.`,
    );
  }
  return { id: fy.id, label: fy.label };
}

/**
 * Post the accrual voucher for every commission run of `agentId` whose period
 * ended on or before `billingEnd` and that has not been accrued to the GL yet.
 *
 * Dated `billingEnd`, NOT today — that is what puts July's commission in July
 * when the run is executed in August.
 */
export async function accrueAgentCommission(opts: {
  agentId: string;
  billingEnd: Date;
  actorId: string;
  dryRun?: boolean;
}): Promise<AccrualResult> {
  const { agentId, billingEnd, actorId } = opts;

  const agent = await prisma.sellingAgent.findUnique({
    where: { id: agentId },
    select: { code: true, fullName: true },
  });
  if (!agent) throw new PayoutError("Agent not found.");

  // `status: accrued` also excludes `reversed` rows, which are restatements
  // and must never be picked up as if they were fresh obligations.
  const runs = await prisma.commissionRun.findMany({
    where: {
      agentId,
      journalBatchId: null,
      status: "accrued",
      periodEnd: { not: null, lte: billingEnd },
    },
    select: { id: true, amount: true, periodStart: true, periodEnd: true, type: true },
    orderBy: { periodEnd: "asc" },
  });

  const zeroSplit = { upfront: 0, trail: 0, clawback: 0 };
  const empty: AccrualResult = {
    noop: true,
    voucherNo: "",
    batchId: "",
    amount: 0,
    runs: 0,
    byType: zeroSplit,
    periodStart: null,
    periodEnd: ymd(billingEnd),
  };
  if (runs.length === 0) return empty;

  const byType = {
    upfront: round2(
      runs.filter((r) => r.type === "upfront").reduce((s, r) => s + Number(r.amount), 0),
    ),
    trail: round2(runs.filter((r) => r.type === "trail").reduce((s, r) => s + Number(r.amount), 0)),
    clawback: round2(
      runs.filter((r) => r.type === "clawback").reduce((s, r) => s + Number(r.amount), 0),
    ),
  };
  const gross = round2(runs.reduce((s, r) => s + Number(r.amount), 0));
  if (gross <= 0) {
    // Only reachable once clawbacks exist and outweigh the period's earnings.
    // Refuse rather than post a backwards voucher: a negative accrual is a
    // credit note against the agent and needs a decision, not a default.
    throw new PayoutError(
      `The ${runs.length} un-accrued run(s) net to ${gross.toFixed(2)} — a zero or negative accrual is not posted automatically. Review the clawback rows first.`,
    );
  }

  const starts = runs.map((r) => r.periodStart).filter((d): d is Date => d !== null);
  const earliest = starts.length
    ? starts.reduce((a, b) => (a < b ? a : b))
    : null;

  const fy = await fiscalYearFor(billingEnd, "accrual voucher");
  const desc = `Selling agent commission accrued — ${agent.code} ${agent.fullName} (to ${ymd(billingEnd)})`;

  if (opts.dryRun) {
    return {
      noop: false,
      voucherNo: "(dry run)",
      batchId: "",
      amount: gross,
      runs: runs.length,
      byType,
      periodStart: earliest ? ymd(earliest) : null,
      periodEnd: ymd(billingEnd),
    };
  }

  const batchId = randomUUID();
  let voucherNo = "";

  await withActor(actorId, async (tx) => {
    voucherNo = await allocateVoucherNo(tx, fy.id, fy.label, "AC");

    await tx.journal.createMany({
      data: [
        {
          entryDate: billingEnd,
          description: desc,
          txnType: "AC",
          voucherNo,
          accountName: EXPENSE_ACCOUNT,
          debit: gross,
          credit: 0,
          fiscalYearId: fy.id,
          batchId,
          agentId,
          createdBy: actorId,
        },
        {
          entryDate: billingEnd,
          description: desc,
          txnType: "AC",
          voucherNo,
          accountName: PAYABLE_ACCOUNT,
          debit: 0,
          credit: gross,
          fiscalYearId: fy.id,
          batchId,
          agentId,
          createdBy: actorId,
        },
      ],
    });

    // Stamping journalBatchId is what makes a second click a no-op: the
    // selection above only sees rows where it is still null.
    await tx.commissionRun.updateMany({
      where: { id: { in: runs.map((r) => r.id) } },
      data: { journalBatchId: batchId, status: "approved" },
    });
  });

  return {
    noop: false,
    voucherNo,
    batchId,
    amount: gross,
    runs: runs.length,
    byType,
    periodStart: earliest ? ymd(earliest) : null,
    periodEnd: ymd(billingEnd),
  };
}

/**
 * Post the payment voucher — the bank transfer that settles everything accrued
 * up to `billingEnd`, dated the day the money actually left.
 *
 * `withholdingPct` is applied to the gross, so gross = withholding + net by
 * construction; the DB enforces that identity too
 * (07_commission_payment.sql).
 */
export async function payAgentCommission(opts: {
  agentId: string;
  billingEnd: Date;
  paidOn: Date;
  bankAccountName: string;
  withholdingPct: number;
  actorId: string;
  dryRun?: boolean;
}): Promise<PaymentResult> {
  const { agentId, billingEnd, paidOn, bankAccountName, withholdingPct, actorId } = opts;

  if (paidOn < billingEnd) {
    throw new PayoutError(
      `Payment date ${ymd(paidOn)} is before the billing period end ${ymd(billingEnd)} — cash cannot leave before the period it settles has closed.`,
    );
  }
  if (!(withholdingPct >= 0 && withholdingPct < 1)) {
    throw new PayoutError(
      "Withholding rate must be between 0% and 100% (exclusive) — enter it as a percentage, e.g. 10 for 10%.",
    );
  }

  const agent = await prisma.sellingAgent.findUnique({
    where: { id: agentId },
    select: { code: true, fullName: true },
  });
  if (!agent) throw new PayoutError("Agent not found.");

  // Cash may only leave a real bank/cash account. Without this check a typo in
  // the account name would credit some unrelated ledger and still balance.
  const bank = await prisma.chartOfAccount.findUnique({
    where: { name: bankAccountName },
    select: { name: true, normalBalance: true, isActive: true },
  });
  if (!bank || !bank.isActive || bank.normalBalance !== "DEBIT") {
    throw new PayoutError(
      `"${bankAccountName}" is not an active asset account — pick the bank the transfer left from.`,
    );
  }

  // Accrued to the GL (journalBatchId set by the accrual step) and not yet
  // settled. Runs still missing an accrual voucher are deliberately excluded:
  // paying them here would clear a payable that was never raised.
  const runs = await prisma.commissionRun.findMany({
    where: {
      agentId,
      status: "approved",
      paidOn: null,
      paymentId: null,
      journalBatchId: { not: null },
      periodEnd: { not: null, lte: billingEnd },
    },
    select: { id: true, amount: true, periodStart: true, journalBatchId: true },
  });

  const empty: PaymentResult = {
    noop: true,
    voucherNo: "",
    batchId: "",
    paymentId: "",
    gross: 0,
    withholding: 0,
    net: 0,
    runs: 0,
  };
  if (runs.length === 0) return empty;

  const gross = round2(runs.reduce((s, r) => s + Number(r.amount), 0));
  if (gross <= 0) {
    throw new PayoutError(
      `The accrued runs net to ${gross.toFixed(2)} — nothing to transfer.`,
    );
  }
  const withholding = round2(gross * withholdingPct);
  // Net is the remainder, not an independent rounding, so the three figures
  // add up exactly at 2dp whatever the rate.
  const net = round2(gross - withholding);

  const starts = runs.map((r) => r.periodStart).filter((d): d is Date => d !== null);
  const earliest = starts.length ? starts.reduce((a, b) => (a < b ? a : b)) : null;
  // Runs accrued across several billing periods share one payout; record the
  // accrual voucher only when they all came from the same one.
  const accrualBatches = new Set(runs.map((r) => r.journalBatchId!));
  const accrualBatchId = accrualBatches.size === 1 ? runs[0]!.journalBatchId! : null;

  const fy = await fiscalYearFor(paidOn, "payment voucher");
  const desc = `Selling agent commission paid — ${agent.code} ${agent.fullName} (period to ${ymd(billingEnd)})`;

  if (opts.dryRun) {
    return {
      noop: false,
      voucherNo: "(dry run)",
      batchId: "",
      paymentId: "",
      gross,
      withholding,
      net,
      runs: runs.length,
    };
  }

  const batchId = randomUUID();
  let voucherNo = "";
  let paymentId = "";

  await withActor(actorId, async (tx) => {
    voucherNo = await allocateVoucherNo(tx, fy.id, fy.label, "CP");

    const line = (accountName: string, debit: number, credit: number) => ({
      entryDate: paidOn,
      description: desc,
      txnType: "CP",
      voucherNo,
      accountName,
      debit,
      credit,
      fiscalYearId: fy.id,
      batchId,
      agentId,
      createdBy: actorId,
    });

    const lines = [
      line(PAYABLE_ACCOUNT, gross, 0),
      line(bank.name, 0, net),
    ];
    // A zero withholding line would balance fine but clutters every voucher of
    // an agent who is paid gross.
    if (withholding > 0) lines.push(line(WITHHOLDING_ACCOUNT, 0, withholding));

    await tx.journal.createMany({ data: lines });

    const payment = await tx.commissionPayment.create({
      data: {
        agentId,
        periodStart: earliest,
        periodEnd: billingEnd,
        paidOn,
        grossAmount: gross,
        withholdingAmount: withholding,
        netAmount: net,
        withholdingPct,
        bankAccountName: bank.name,
        accrualBatchId,
        paymentBatchId: batchId,
        notes: `${runs.length} run(s) settled · voucher ${voucherNo}`,
        createdBy: actorId,
      },
    });
    paymentId = payment.id;

    await tx.commissionRun.updateMany({
      where: { id: { in: runs.map((r) => r.id) } },
      data: { status: "paid", paidOn, paymentId: payment.id },
    });
  });

  return {
    noop: false,
    voucherNo,
    batchId,
    paymentId,
    gross,
    withholding,
    net,
    runs: runs.length,
  };
}

/** One settled transfer, with the split of what it actually paid for. */
export type AgentPaymentRow = {
  id: string;
  periodStart: string | null;
  /** The billing cut-off this payment settled — "commission earned up to". */
  periodEnd: string;
  paidOn: string;
  upfront: number;
  trail: number;
  gross: number;
  withholding: number;
  net: number;
  withholdingPct: number;
  bankAccountName: string;
  accrualBatchId: string | null;
  paymentBatchId: string;
  runs: number;
};

/**
 * Every transfer made to an agent, newest first, with each one broken into the
 * upfront and trail it settled.
 *
 * The split is derived from the settled runs themselves (`CommissionRun.
 * paymentId`), not stored separately, so it cannot drift from the rows it
 * describes. Shared by the admin payout panel, the agent's earnings page and
 * both workbooks — the agent must be able to see what was paid, for which
 * period, and how much tax was deducted, and the office copy has to say the
 * same thing.
 */
export async function listAgentPayments(agentId: string): Promise<AgentPaymentRow[]> {
  const rows = await prisma.commissionPayment.findMany({
    where: { agentId },
    orderBy: [{ paidOn: "desc" }, { createdAt: "desc" }],
    include: { runs: { select: { type: true, amount: true } } },
  });
  return rows.map((p) => {
    const sum = (t: "upfront" | "trail") =>
      round2(
        p.runs.filter((r) => r.type === t).reduce((s, r) => s + Number(r.amount), 0),
      );
    return {
      id: p.id,
      periodStart: p.periodStart ? ymd(p.periodStart) : null,
      periodEnd: ymd(p.periodEnd),
      paidOn: ymd(p.paidOn),
      upfront: sum("upfront"),
      trail: sum("trail"),
      gross: round2(Number(p.grossAmount)),
      withholding: round2(Number(p.withholdingAmount)),
      net: round2(Number(p.netAmount)),
      withholdingPct: Number(p.withholdingPct),
      bankAccountName: p.bankAccountName,
      accrualBatchId: p.accrualBatchId,
      paymentBatchId: p.paymentBatchId,
      runs: p.runs.length,
    };
  });
}

/**
 * What the payout panel needs to render, without duplicating the selection
 * logic above: how much is waiting to be accrued, and how much is accrued and
 * waiting to be paid, as of a billing cut-off — each split by commission type,
 * because one Accrue button sweeps upfront and trail into a single voucher and
 * the accountant could not otherwise see what was inside the figure.
 */
export type PayoutBucket = {
  runs: number;
  amount: number;
  byType: { upfront: number; trail: number; clawback: number };
};

export async function getPayoutState(
  agentId: string,
  billingEnd: Date,
): Promise<{ unaccrued: PayoutBucket; unpaid: PayoutBucket }> {
  const [unaccruedRows, unpaidRows] = await Promise.all([
    prisma.commissionRun.findMany({
      where: {
        agentId,
        journalBatchId: null,
        status: "accrued",
        periodEnd: { not: null, lte: billingEnd },
      },
      select: { amount: true, type: true },
    }),
    prisma.commissionRun.findMany({
      where: {
        agentId,
        status: "approved",
        paidOn: null,
        paymentId: null,
        journalBatchId: { not: null },
        periodEnd: { not: null, lte: billingEnd },
      },
      select: { amount: true, type: true },
    }),
  ]);
  // These `where` clauses are verbatim copies of the selections in
  // accrueAgentCommission / payAgentCommission — the card must describe exactly
  // what the button will act on.
  const bucket = (rows: Array<{ amount: unknown; type: string }>): PayoutBucket => {
    const of = (t: string) =>
      round2(rows.filter((r) => r.type === t).reduce((s, r) => s + Number(r.amount), 0));
    return {
      runs: rows.length,
      amount: round2(rows.reduce((s, r) => s + Number(r.amount), 0)),
      byType: { upfront: of("upfront"), trail: of("trail"), clawback: of("clawback") },
    };
  };
  return { unaccrued: bucket(unaccruedRows), unpaid: bucket(unpaidRows) };
}
