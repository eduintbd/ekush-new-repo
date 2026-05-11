// Single entry point for "give me IS + BS for fiscal year X". Wraps the
// trial-balance fetch, the ExternalInputs wiring, and the two-pass
// dependency between IS (computes net profit / tax) and BS (consumes them).
//
// External inputs:
//   - unrealisedFairValueLoss: derived from InvestmentHolding rows if any
//     exist (Annexure-B), else 0. Override via the `overrides` arg to test
//     workbook scenarios.
//   - currentTaxProvision, fairValueReceivableAdjustment: no schema yet
//     (Notes (2) + Annexure receivable adj). 0 until overridden.

import { prisma } from "@/lib/prisma";
import { getTrialBalance, toMappingTrialBalance, type TrialBalanceReport } from "@/lib/trial-balance";
import {
  buildIncomeStatement,
  buildBalanceSheet,
  buildChangesInEquity,
  ACCOUNT,
  type ExternalInputs,
  type IncomeStatement,
  type BalanceSheet,
  type ChangesInEquity,
  type TrialBalance,
} from "@/lib/statement_mapping";
import { getUnrealisedFairValueLoss } from "@/lib/annexures";
import type { FiscalYear } from "@/generated/prisma";

/** Inputs the caller can override; the rest are derived from IS. */
export type StatementOverrides = Partial<
  Pick<
    ExternalInputs,
    "unrealisedFairValueLoss" | "currentTaxProvision" | "fairValueReceivableAdjustment"
  >
>;

export type Statements = {
  fiscalYear: FiscalYear;
  trialBalance: TrialBalanceReport;
  /** Same data as `trialBalance`, keyed by account name. Empty rows omitted. */
  tbMap: TrialBalance;
  external: ExternalInputs;
  incomeStatement: IncomeStatement;
  balanceSheet: BalanceSheet;
  changesInEquity: ChangesInEquity;
};

const ZERO_OVERRIDES: Required<StatementOverrides> = {
  unrealisedFairValueLoss: 0,
  currentTaxProvision: 0,
  fairValueReceivableAdjustment: 0,
};

/**
 * Computes IS + BS for a fiscal year. IS is built first so its
 * profitForPeriod / taxExpense can feed BS Retained Earnings + Provision
 * for Income Tax.
 */
export async function getStatements(
  fiscalYearId: string,
  overrides: StatementOverrides = {},
): Promise<Statements> {
  const fiscalYear = await prisma.fiscalYear.findUniqueOrThrow({
    where: { id: fiscalYearId },
  });
  const trialBalance = await getTrialBalance(fiscalYearId);
  const tbMap = toMappingTrialBalance(trialBalance);

  // Derive unrealisedFairValueLoss from InvestmentHolding rows if the
  // caller didn't pass an override.
  const defaults: Required<StatementOverrides> = { ...ZERO_OVERRIDES };
  if (overrides.unrealisedFairValueLoss === undefined) {
    defaults.unrealisedFairValueLoss = await getUnrealisedFairValueLoss(fiscalYearId);
  }

  const external: ExternalInputs = {
    ...defaults,
    ...overrides,
    currentPeriodNetProfit: 0,
    currentPeriodTaxExpense: 0,
  };

  const incomeStatement = buildIncomeStatement(tbMap, external);
  external.currentPeriodNetProfit = incomeStatement.profitForPeriod;
  external.currentPeriodTaxExpense = incomeStatement.taxExpense.reduce(
    (s, l) => s + l.amount,
    0,
  );
  const balanceSheet = buildBalanceSheet(tbMap, external);

  // Opening balances for the three equity accounts feed the CE rollforward.
  const equityOpenings = await safeQuery(() =>
    prisma.accountOpeningBalance.findMany({
      where: {
        fiscalYearId,
        accountName: { in: [ACCOUNT.shareCapital, ACCOUNT.fairValueReserve, ACCOUNT.retainedEarning] },
      },
      select: { accountName: true, openingCredit: true },
    }),
  );
  const obByName = new Map((equityOpenings ?? []).map((r) => [r.accountName, Number(r.openingCredit)]));
  const changesInEquity = buildChangesInEquity(
    tbMap,
    incomeStatement,
    {
      shareCapital: obByName.get(ACCOUNT.shareCapital),
      fairValueReserve: obByName.get(ACCOUNT.fairValueReserve),
      retainedEarning: obByName.get(ACCOUNT.retainedEarning),
    },
    fiscalYear,
  );

  return {
    fiscalYear,
    trialBalance,
    tbMap,
    external,
    incomeStatement,
    balanceSheet,
    changesInEquity,
  };
}

async function safeQuery<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}
