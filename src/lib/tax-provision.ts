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

  // 6. Reconciliation vs journaled accruals
  const journaledCurrentTax = netC(ACCT.PROVISION_INCOME_TAX);
  const journaledDeferredTax = netC(ACCT.DEFERRED_TAX);
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

// ─── helpers ─────────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function fmt(n: number): string {
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
