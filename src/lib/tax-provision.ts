// Tax-provision computation engine. The single source of truth for
// "what is the statutory tax expense for this period". Reads taxable
// bases from the trial balance, applies the rates effective at the
// period end (from the tax_rates table), and reconciles against
// what's already accrued in the Provision-for-Income-Tax and
// Deferred-Tax journal accounts.
//
// Phase 2 of the Tax Provision module — Panel B (Computation
// Preview) on the admin card consumes this verbatim. Phase 3 will
// add the posting + locking flow that mutates state; Phase 5 will
// add mid-period rate proration and loss carry-forward.

import { prisma } from "@/lib/prisma";
import { getTrialBalance } from "@/lib/trial-balance";
import { getStatements } from "@/lib/statements";
import { getTaxRatesAt, type TaxRates } from "@/lib/tax-rates";

// ─── Inputs / Outputs ────────────────────────────────────────────

export type TaxProvisionOverrides = {
  /** When set, overrides the lookup. Use for "what if I changed CG
   *  to 10%" scenario testing without writing to the rates table. */
  taxRates?: Partial<TaxRates>;
  /** Mgmt-fee TDS already withheld at source. The workbook calls
   *  this Notes(2)!F11 — accountant supplies it directly. */
  mgmtFeeAtSourceAmount?: number;
  /** Materiality threshold for the reconciliation warning. Default
   *  1% of profit-before-tax. */
  materialityPct?: number;
  /** Allow capital losses to offset against future-period capital
   *  gains (Phase 5 storage). Default off — losses for the period
   *  floor capitalGainNet at zero. */
  lossCarryForwardEnabled?: boolean;
};

export type TaxBases = {
  capitalGainGross: number;
  capitalLoss: number;
  capitalGainNet: number;
  dividendIncome: number;
  interestIncomeSnd: number;
  interestIncomeFdr: number;
  interestIncomeTotal: number;
  mgmtFeeRevenue: number;
  /** Sign convention: positive = unrealised gain (increases DTL). */
  fairValueChange: number;
  /** Net Dr balance of "Source Tax" — AIT withheld at source. */
  sourceTaxCredits: number;
  /** From IS, for ETR display. */
  profitBeforeTax: number;
};

export type CurrentTaxBreakdown = {
  cg: number;
  dividend: number;
  interest: number;
  mgmt: number;
  total: number;
};

export type ReconciliationResult = {
  journaledCurrentTax: number;
  journaledDeferredTax: number;
  varianceCurrent: number;
  varianceDeferred: number;
  /** True if either |variance| exceeds materialityPct × profitBeforeTax. */
  isMaterial: boolean;
  materialityAmount: number;
};

export type SanityCheckResult = {
  ok: boolean;
  message?: string;
};

export type SanityChecks = {
  capitalLossWithinGain: SanityCheckResult;
  sourceTaxCreditsWithinExpense: SanityCheckResult;
  deferredTaxBaseTiesToOci: SanityCheckResult;
  periodIsOpen: SanityCheckResult;
  ratesEffectiveBeforePeriod: SanityCheckResult;
};

export type TaxProvisionResult = {
  fiscalYearId: string;
  fiscalYearLabel: string;
  periodStart: Date;
  periodEnd: Date;
  isClosed: boolean;
  taxRates: TaxRates;
  bases: TaxBases;
  currentTax: CurrentTaxBreakdown;
  deferredTax: number;
  reconciliation: ReconciliationResult;
  sanityChecks: SanityChecks;
  /** Effective tax rate = current_tax_total / profit_before_tax.
   *  Returns null when profitBeforeTax is zero or negative. */
  etr: number | null;
};

// ─── Account names the engine pulls from ─────────────────────────
// Kept here, not pulled from statement_mapping.ts's ACCOUNT, to make
// this module unit-testable in isolation. Must stay aligned with the
// seed names in prisma/seed/chart-of-accounts.ts.

const ACCT = {
  CAPITAL_GAIN: "Capital Gain",
  CAPITAL_LOSS: "Capital Loss",
  REALISED_GAIN_LOSS: "Realised Gain/(Loss) on Investments",
  DIVIDEND_INCOME: "Dividend Income",
  INTEREST_INCOME: "Interest Income",
  INTEREST_INCOME_FDR: "Interest Income of FDR",
  MGMT_FEE: "Management Fee",
  SOURCE_TAX: "Source Tax",
  PROVISION_INCOME_TAX: "Provision for income tax",
  DEFERRED_TAX: "Deferred Tax",
} as const;

// ─── Compute ─────────────────────────────────────────────────────

export async function computeTaxProvision(
  fiscalYearId: string,
  overrides: TaxProvisionOverrides = {},
): Promise<TaxProvisionResult> {
  const fy = await prisma.fiscalYear.findUniqueOrThrow({
    where: { id: fiscalYearId },
  });

  // 1. Bases from TB
  const tb = await getTrialBalance(fiscalYearId);
  const row = (name: string) => tb.rows.find((r) => r.accountName === name);
  const grossD = (name: string) => Number(row(name)?.grossDebit ?? 0);
  const grossC = (name: string) => Number(row(name)?.grossCredit ?? 0);
  const netD = (name: string) => Number(row(name)?.netDebit ?? 0);
  const netC = (name: string) => Number(row(name)?.netCredit ?? 0);

  // Capital gain: legacy workbook accounts plus the Phase-1 trade
  // engine account (signed net).
  const capitalGainGross =
    grossC(ACCT.CAPITAL_GAIN) - grossD(ACCT.CAPITAL_GAIN) +
    (netC(ACCT.REALISED_GAIN_LOSS) - netD(ACCT.REALISED_GAIN_LOSS));
  const capitalLoss = grossD(ACCT.CAPITAL_LOSS);
  const capitalGainNet = overrides.lossCarryForwardEnabled
    ? capitalGainGross - capitalLoss
    : Math.max(0, capitalGainGross - capitalLoss);

  const dividendIncome = netC(ACCT.DIVIDEND_INCOME);
  // Both interest streams live on one account today (no SND/FDR
  // split). When the seed adds an "Interest Income SND" row, this
  // line will need to break out — leaving the FDR bucket separate
  // makes the disclosure-side rollforward cleaner.
  const interestIncomeFdr = netC(ACCT.INTEREST_INCOME_FDR);
  const interestIncomeSnd = 0;
  const interestIncomeTotal =
    interestIncomeFdr + interestIncomeSnd + netC(ACCT.INTEREST_INCOME);

  const mgmtFeeRevenue = netC(ACCT.MGMT_FEE);
  const sourceTaxCredits = netD(ACCT.SOURCE_TAX);

  // 2. Tax rates — apply overrides on top of the DB lookup.
  const baseRates = await getTaxRatesAt(fy.endsOn);
  const taxRates: TaxRates = {
    ...baseRates,
    ...(overrides.taxRates ?? {}),
  };

  // 3. IS pull for profit-before-tax + fair-value-change. getStatements
  // runs the full pipeline (and reads its own rates from the DB — we
  // accept its profitBeforeTax as authoritative since it's what the
  // BS uses).
  const stmts = await getStatements(fiscalYearId);
  const profitBeforeTax = stmts.incomeStatement.profitBeforeTax;

  // OCI base — sign flipped per spec. ext.unrealisedFairValueLoss is
  // positive for a loss; the deferred-tax base wants positive for
  // gain. So gain = -loss.
  const fairValueChange = -stmts.external.unrealisedFairValueLoss;

  const bases: TaxBases = {
    capitalGainGross,
    capitalLoss,
    capitalGainNet,
    dividendIncome,
    interestIncomeSnd,
    interestIncomeFdr,
    interestIncomeTotal,
    mgmtFeeRevenue,
    fairValueChange,
    sourceTaxCredits,
    profitBeforeTax,
  };

  // 4. Current tax
  const currentTax: CurrentTaxBreakdown = {
    cg: round2(Math.max(0, capitalGainNet) * taxRates.CAPITAL_GAIN),
    dividend: round2(dividendIncome * taxRates.DIVIDEND),
    interest: round2(interestIncomeTotal * taxRates.INTEREST),
    mgmt: round2(overrides.mgmtFeeAtSourceAmount ?? 0),
    total: 0,
  };
  currentTax.total = round2(
    currentTax.cg + currentTax.dividend + currentTax.interest + currentTax.mgmt,
  );

  // 5. Deferred tax
  const deferredTax = round2(fairValueChange * taxRates.DEFERRED);

  // 6. Reconciliation vs journaled accruals.
  // Period accrual = (total activity) − (OB carryforward) − (our own
  // TX top-ups). Computed by subtraction rather than a `NOT IN`
  // filter because Postgres `NOT IN ('OB','TX')` excludes rows where
  // txnType IS NULL (e.g. plain manual JVs entered without a
  // txnType), which would understate the real period accrual.
  // Without this fix the engine reads the 19.87L FY24-25 OB Cr as
  // "already provided" current tax and posts a reversal.
  const journaledCurrentTax = await periodNetCredit(
    fiscalYearId,
    ACCT.PROVISION_INCOME_TAX,
  );
  const journaledDeferredTax = await periodNetCredit(
    fiscalYearId,
    ACCT.DEFERRED_TAX,
  );
  const varianceCurrent = round2(currentTax.total - journaledCurrentTax);
  const varianceDeferred = round2(deferredTax - journaledDeferredTax);
  const materialityPct = overrides.materialityPct ?? 0.01;
  const materialityAmount = round2(Math.abs(profitBeforeTax) * materialityPct);
  const isMaterial =
    Math.abs(varianceCurrent) > materialityAmount ||
    Math.abs(varianceDeferred) > materialityAmount;

  // 7. Sanity checks
  const sanityChecks: SanityChecks = {
    capitalLossWithinGain: overrides.lossCarryForwardEnabled
      ? { ok: true }
      : capitalLoss <= capitalGainGross
        ? { ok: true }
        : {
            ok: false,
            message: `Capital loss ${fmt(capitalLoss)} exceeds capital gain ${fmt(capitalGainGross)}. Excess ${fmt(capitalLoss - capitalGainGross)} is being floored to zero (carry-forward disabled).`,
          },
    sourceTaxCreditsWithinExpense:
      sourceTaxCredits <= currentTax.total + 0.005
        ? { ok: true }
        : {
            ok: false,
            message: `Source tax credits (AIT) ${fmt(sourceTaxCredits)} exceed current-tax expense ${fmt(currentTax.total)} — the company is owed a refund of ${fmt(sourceTaxCredits - currentTax.total)}.`,
          },
    deferredTaxBaseTiesToOci:
      Math.abs(fairValueChange - (-stmts.external.unrealisedFairValueLoss)) < 0.005
        ? { ok: true }
        : {
            ok: false,
            message: `Deferred-tax base (${fmt(fairValueChange)}) does not match IS OCI unrealised (${fmt(-stmts.external.unrealisedFairValueLoss)}). Cannot post — fix the source of one of them first.`,
          },
    periodIsOpen: fy.isClosed
      ? {
          ok: false,
          message: `Fiscal year ${fy.label} is closed. Reopen before posting a top-up entry.`,
        }
      : { ok: true },
    ratesEffectiveBeforePeriod: await checkRatesEffective(fy.startsOn),
  };

  return {
    fiscalYearId,
    fiscalYearLabel: fy.label,
    periodStart: fy.startsOn,
    periodEnd: fy.endsOn,
    isClosed: fy.isClosed,
    taxRates,
    bases,
    currentTax,
    deferredTax,
    reconciliation: {
      journaledCurrentTax,
      journaledDeferredTax,
      varianceCurrent,
      varianceDeferred,
      isMaterial,
      materialityAmount,
    },
    sanityChecks,
    etr: profitBeforeTax > 0 ? currentTax.total / profitBeforeTax : null,
  };
}

async function checkRatesEffective(periodStart: Date): Promise<SanityCheckResult> {
  const types = ["CAPITAL_GAIN", "DIVIDEND", "INTEREST", "DEFERRED"] as const;
  const missing: string[] = [];
  for (const t of types) {
    const row = await prisma.taxRate.findFirst({
      where: { rateType: t, effectiveFrom: { lte: periodStart } },
      orderBy: { effectiveFrom: "desc" },
    });
    if (!row) missing.push(t);
  }
  if (missing.length === 0) return { ok: true };
  return {
    ok: false,
    message: `No rate row with effective_from ≤ period start for: ${missing.join(", ")}. The engine is falling back to DEFAULT_RATES — add a row in /admin/tax-provision before the next period.`,
  };
}

// ─── History ─────────────────────────────────────────────────────

export type ProvisionHistoryRow = {
  id: string;
  computedAt: Date;
  computedBy: string | null;
  status: string;
  currentTaxTotal: number;
  deferredTaxTotal: number;
  varianceCurrent: number;
  varianceDeferred: number;
  postings: Array<{
    id: string;
    amount: number;
    type: string;
    journalBatchId: string;
    postedAt: Date;
  }>;
};

/**
 * Last N TaxProvision rows for the given FY with their postings.
 * Powers the audit-trail panel on /admin/tax-provision.
 */
export async function getProvisionHistory(
  fiscalYearId: string,
  limit: number = 10,
): Promise<ProvisionHistoryRow[]> {
  const rows = await prisma.taxProvision.findMany({
    where: { fiscalYearId },
    orderBy: { computedAt: "desc" },
    take: limit,
    include: { postings: true },
  });
  return rows.map((r) => ({
    id: r.id,
    computedAt: r.computedAt,
    computedBy: r.computedBy,
    status: r.status,
    currentTaxTotal: Number(r.currentTaxTotal),
    deferredTaxTotal: Number(r.deferredTaxTotal),
    varianceCurrent: Number(r.varianceCurrent),
    varianceDeferred: Number(r.varianceDeferred),
    postings: r.postings.map((p) => ({
      id: p.id,
      amount: Number(p.amount),
      type: p.type,
      journalBatchId: p.journalBatchId,
      postedAt: p.postedAt,
    })),
  }));
}

// ─── helpers ─────────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** SUMIFS: net Dr on the "Source Tax" account for journal vouchers
 *  that also include a "Management Fee" or "Management Fee Accrued"
 *  leg, excluding OB. Mirrors the workbook's Notes(2)!F11 — the
 *  source-tax-already-withheld figure that gets added to base income
 *  tax to form the full current-tax provision.
 *
 *  Excludes OB explicitly: all opening balances share voucher
 *  OB/25-26/0001, and that voucher does have Mgmt Fee lines (the
 *  opening receivable), so it'd otherwise pull in the OB Source Tax
 *  carryforward (~17L) that doesn't belong to the period. */
export async function getMgmtFeeTdsFromLedger(
  fiscalYearId: string,
): Promise<number> {
  const mgmtVouchers = await prisma.journal.findMany({
    where: {
      fiscalYearId,
      accountName: { in: ["Management Fee", "Management Fee Accrued"] },
      voucherNo: { not: null },
    },
    select: { voucherNo: true },
    distinct: ["voucherNo"],
  });
  // Drop OB voucher numbers from the candidate set. The OB voucher
  // does touch Mgmt Fee (opening receivable) but we don't want to
  // pull its Source Tax Dr (~17L of prior-year carryforward). Avoids
  // a downstream txnType filter and its NULL-handling gotcha.
  const voucherNos = mgmtVouchers
    .map((v) => v.voucherNo)
    .filter((v): v is string => v !== null && !v.startsWith("OB/"));
  if (voucherNos.length === 0) return 0;

  const agg = await prisma.journal.aggregate({
    where: {
      fiscalYearId,
      accountName: ACCT.SOURCE_TAX,
      voucherNo: { in: voucherNos },
    },
    _sum: { debit: true, credit: true },
  });
  const dr = Number(agg._sum.debit ?? 0);
  const cr = Number(agg._sum.credit ?? 0);
  return Math.max(0, dr - cr);
}

/** Net credit balance for the period, excluding OB carryforward and
 *  our own TX top-ups. Uses subtraction rather than a NOT IN filter to
 *  correctly count rows whose txnType IS NULL. */
async function periodNetCredit(
  fiscalYearId: string,
  accountName: string,
): Promise<number> {
  const [total, ob, tx] = await Promise.all([
    prisma.journal.aggregate({
      where: { fiscalYearId, accountName },
      _sum: { debit: true, credit: true },
    }),
    prisma.journal.aggregate({
      where: { fiscalYearId, accountName, txnType: "OB" },
      _sum: { debit: true, credit: true },
    }),
    prisma.journal.aggregate({
      where: { fiscalYearId, accountName, txnType: "TX" },
      _sum: { debit: true, credit: true },
    }),
  ]);
  const dr =
    Number(total._sum.debit ?? 0) -
    Number(ob._sum.debit ?? 0) -
    Number(tx._sum.debit ?? 0);
  const cr =
    Number(total._sum.credit ?? 0) -
    Number(ob._sum.credit ?? 0) -
    Number(tx._sum.credit ?? 0);
  return Math.max(0, cr - dr);
}

function fmt(n: number): string {
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
