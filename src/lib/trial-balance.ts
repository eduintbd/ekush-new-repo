// Computes the trial balance for a fiscal year by aggregating Journal lines
// per account. Mirrors the workbook's TB-C: K = max(0, ΣH−ΣI) (net debit),
// L = max(0, ΣI−ΣH) (net credit). Returns rows in CoA SL order so the
// staff portal table reads like the workbook.

import { prisma } from "@/lib/prisma";
import type { AccountAggregate, TrialBalance } from "@/lib/statement_mapping";

export type TrialBalanceRow = {
  sl: number;
  accountName: string;
  normalBalance: "DEBIT" | "CREDIT";
  grossDebit: number;
  grossCredit: number;
  netDebit: number;
  netCredit: number;
};

export type TrialBalanceReport = {
  fiscalYearLabel: string;
  startsOn: Date;
  endsOn: Date;
  rows: TrialBalanceRow[];
  totals: {
    grossDebit: number;
    grossCredit: number;
    netDebit: number;
    netCredit: number;
  };
  /** True iff Σ net debit === Σ net credit (within BDT 1). */
  isBalanced: boolean;
};

/**
 * Aggregates Journal rows per account for the given fiscal year and joins
 * with ChartOfAccount to produce the trial balance. Cheap on small datasets;
 * for >100k journal rows, replace with a SQL view (`trial_balance_v` per
 * spec §5.11) and read via $queryRaw.
 */
export async function getTrialBalance(fiscalYearId: string): Promise<TrialBalanceReport> {
  const fy = await prisma.fiscalYear.findUniqueOrThrow({
    where: { id: fiscalYearId },
  });

  const accounts = await prisma.chartOfAccount.findMany({
    where: { isActive: true },
    orderBy: { sl: "asc" },
  });

  // Aggregate journal lines for the period.
  const aggregates = await prisma.journal.groupBy({
    by: ["accountName"],
    where: { fiscalYearId },
    _sum: { debit: true, credit: true },
  });
  const aggMap = new Map(
    aggregates.map((a) => [
      a.accountName,
      {
        grossDebit: Number(a._sum.debit ?? 0),
        grossCredit: Number(a._sum.credit ?? 0),
      },
    ]),
  );

  const rows: TrialBalanceRow[] = accounts.map((acc) => {
    const agg = aggMap.get(acc.name) ?? { grossDebit: 0, grossCredit: 0 };
    const netDebit = Math.max(0, agg.grossDebit - agg.grossCredit);
    const netCredit = Math.max(0, agg.grossCredit - agg.grossDebit);
    return {
      sl: acc.sl,
      accountName: acc.name,
      normalBalance: acc.normalBalance as "DEBIT" | "CREDIT",
      grossDebit: agg.grossDebit,
      grossCredit: agg.grossCredit,
      netDebit,
      netCredit,
    };
  });

  const totals = rows.reduce(
    (s, r) => ({
      grossDebit: s.grossDebit + r.grossDebit,
      grossCredit: s.grossCredit + r.grossCredit,
      netDebit: s.netDebit + r.netDebit,
      netCredit: s.netCredit + r.netCredit,
    }),
    { grossDebit: 0, grossCredit: 0, netDebit: 0, netCredit: 0 },
  );

  return {
    fiscalYearLabel: fy.label,
    startsOn: fy.startsOn,
    endsOn: fy.endsOn,
    rows,
    totals,
    isBalanced: Math.abs(totals.netDebit - totals.netCredit) < 1,
  };
}

/**
 * Convert a TrialBalanceReport into the Map keyed by account name that
 * statement_mapping.ts expects.
 */
export function toMappingTrialBalance(report: TrialBalanceReport): TrialBalance {
  const tb: TrialBalance = new Map();
  for (const row of report.rows) {
    if (row.grossDebit === 0 && row.grossCredit === 0) continue;
    const agg: AccountAggregate = {
      grossDebit: row.grossDebit,
      grossCredit: row.grossCredit,
      netDebit: row.netDebit,
      netCredit: row.netCredit,
    };
    tb.set(row.accountName, agg);
  }
  return tb;
}
