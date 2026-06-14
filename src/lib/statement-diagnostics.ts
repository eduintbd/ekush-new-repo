// Why doesn't the Balance Sheet balance? — deterministic reconciliation.
//
// The trial balance always balances (Σnet-debit = Σnet-credit). The IS/BS are
// built from a hard-coded account-name → line map (statement_mapping.ts), every
// read going through tb.get(name). So a BS that doesn't tie almost always means
// an account has activity but is referenced by NO statement line — it shows in
// the TB but drops out of the BS, unbalancing it by exactly its net balance.
//
// We find those accounts implementation-proof: wrap the TB in a Map that
// records every key the builders ask for, run the real builders, then any TB
// account with a balance that wasn't touched is the leak. Also surface any
// unbalanced voucher (Σdebit ≠ Σcredit) and the non-journaled external inputs.

import { prisma } from "@/lib/prisma";
import { getStatements, type StatementOverrides } from "@/lib/statements";
import {
  buildIncomeStatement,
  buildBalanceSheet,
  type AccountAggregate,
  type TrialBalance,
  type ExternalInputs,
} from "@/lib/statement_mapping";

class RecordingTrialBalance extends Map<string, AccountAggregate> {
  readonly touched = new Set<string>();
  get(key: string): AccountAggregate | undefined {
    this.touched.add(key);
    return super.get(key);
  }
}

export type UnmappedAccount = {
  name: string;
  netDebit: number;
  netCredit: number;
  /** netDebit − netCredit (positive = would have been an asset). */
  signed: number;
};

export type UnbalancedVoucher = {
  batchId: string;
  voucherNo: string | null;
  debit: number;
  credit: number;
  diff: number;
};

/** Independent check from AccountGroup.nature (which the statement builder
 *  ignores). If every account is classified, Assets = Liab + Equity + Profit
 *  exactly; the residual is the signed total of unclassified accounts. */
export type NatureView = {
  assets: number;
  liabilities: number;
  equity: number;
  profit: number;
  /** Assets − (Liab + Equity + Profit); equals −Σsigned(unclassified). */
  residual: number;
};

export type StatementDiagnostics = {
  tbBalanced: boolean;
  tbDiff: number;
  bsDiff: number;
  /** Accounts with a TB balance that no BS/IS line consumes — the leak. */
  unmappedAccounts: UnmappedAccount[];
  unmappedTotalSigned: number;
  /** Accounts with a balance but no AccountGroup (break the nature view; and
   *  usually also unmapped in the statement builder). */
  unclassifiedAccounts: UnmappedAccount[];
  /** Accounts sitting on the OPPOSITE side of their normal balance (a
   *  debit-normal account net-credit, or vice versa). The statement mapping
   *  reads these via netD()/netC() — which drops the opposite side — so the
   *  `wrongSide` amount silently vanishes from the IS/BS. Prime cause of a
   *  mapping-side imbalance. */
  /** `dropped` = the account's wrong-side balance is NOT reflected in the
   *  statements (the mapping reads only the opposite side), so it's part of
   *  the bsDiff. `dropped:false` = read correctly; only the COA normalBalance
   *  flag is mislabelled (harmless noise). */
  signAnomalies: { name: string; normalBalance: string; netDebit: number; netCredit: number; wrongSide: number; dropped: boolean }[];
  natureView: NatureView;
  unbalancedVouchers: UnbalancedVoucher[];
  /** Non-journaled accountant inputs currently applied (audit visibility). */
  externalInputs: { label: string; amount: number }[];
  verdict: string;
};

const TOL = 0.5;

export async function diagnoseStatements(
  fiscalYearId: string,
  overrides: StatementOverrides = {},
  asOfDate?: Date,
): Promise<StatementDiagnostics> {
  const stmts = await getStatements(fiscalYearId, overrides, asOfDate);

  // Second pass with a recording TB to capture every account the builders read.
  const rec = new RecordingTrialBalance(stmts.tbMap);
  buildIncomeStatement(rec as TrialBalance, stmts.external);
  buildBalanceSheet(rec as TrialBalance, stmts.external);
  // (CE only reads equity accounts already consumed by BS — no new touches.)

  const unmappedAccounts: UnmappedAccount[] = [];
  for (const [name, agg] of stmts.tbMap) {
    if (rec.touched.has(name)) continue;
    if (agg.netDebit + agg.netCredit <= TOL) continue;
    unmappedAccounts.push({
      name,
      netDebit: agg.netDebit,
      netCredit: agg.netCredit,
      signed: agg.netDebit - agg.netCredit,
    });
  }
  unmappedAccounts.sort((a, b) => Math.abs(b.signed) - Math.abs(a.signed));
  const unmappedTotalSigned = unmappedAccounts.reduce((s, a) => s + a.signed, 0);

  const bsDiff = stmts.balanceSheet.totalAssets - stmts.balanceSheet.totalEquityAndLiabilities;

  // Sign anomalies: an account on the opposite side of its normal balance.
  // Not all of these matter — the statement mapping reads many such accounts
  // correctly (e.g. income/payables via netC, broker BO accounts that flip to
  // a margin-loan credit). Only the ones the mapping reads ONE-SIDED on the
  // side they're NOT sitting on are actually DROPPED, and those are the gap.
  //
  // Decide it implementation-proof, no hard-coded list: the IS→BS build is
  // pure once the TB is in hand (statements.ts two-pass). Rebuild bsDiff with
  // each account removed; if bsDiff doesn't move, that account's current
  // balance wasn't being reflected → it's dropped.
  const baseExternal: ExternalInputs = {
    ...stmts.external,
    currentPeriodNetProfit: 0,
    currentPeriodTaxExpense: 0,
  };
  const bsDiffFor = (tb: TrialBalance): number => {
    const is = buildIncomeStatement(tb, baseExternal);
    const ext: ExternalInputs = {
      ...baseExternal,
      currentPeriodNetProfit: is.profitForPeriod,
      currentPeriodTaxExpense: is.taxExpense.reduce((s, l) => s + l.amount, 0),
    };
    const bs = buildBalanceSheet(tb, ext);
    return bs.totalAssets - bs.totalEquityAndLiabilities;
  };
  const baselineDiff = bsDiffFor(stmts.tbMap);
  const isDropped = (name: string): boolean => {
    const tb2: TrialBalance = new Map(stmts.tbMap);
    tb2.delete(name);
    return Math.abs(bsDiffFor(tb2) - baselineDiff) < TOL;
  };

  const signAnomalies = stmts.trialBalance.rows
    .filter((r) =>
      (r.normalBalance === "DEBIT" && r.netCredit > TOL) ||
      (r.normalBalance === "CREDIT" && r.netDebit > TOL),
    )
    .map((r) => ({
      name: r.accountName,
      normalBalance: r.normalBalance,
      netDebit: r.netDebit,
      netCredit: r.netCredit,
      wrongSide: r.normalBalance === "DEBIT" ? r.netCredit : r.netDebit,
      dropped: isDropped(r.accountName),
    }))
    // Dropped (real culprits) first, then by size.
    .sort((a, b) => Number(b.dropped) - Number(a.dropped) || b.wrongSide - a.wrongSide);

  // Nature-based reconciliation (uses AccountGroup.nature, independent of the
  // statement builder's hard-coded map).
  const coa = await prisma.chartOfAccount.findMany({ include: { group: { select: { nature: true } } } });
  const natureByName = new Map(coa.map((c) => [c.name, c.group?.nature ?? null]));
  const nat: Record<string, number> = { ASSET: 0, LIABILITY: 0, EQUITY: 0, INCOME: 0, EXPENSE: 0, NULL: 0 };
  const unclassifiedAccounts: UnmappedAccount[] = [];
  for (const [name, agg] of stmts.tbMap) {
    const signed = agg.netDebit - agg.netCredit;
    const nature = natureByName.get(name) ?? null;
    nat[nature ?? "NULL"] += signed;
    if (nature == null && agg.netDebit + agg.netCredit > TOL) {
      unclassifiedAccounts.push({ name, netDebit: agg.netDebit, netCredit: agg.netCredit, signed });
    }
  }
  unclassifiedAccounts.sort((a, b) => Math.abs(b.signed) - Math.abs(a.signed));
  const natAssets = nat.ASSET;
  const natLiab = -nat.LIABILITY;
  const natEquity = -nat.EQUITY;
  const natProfit = -nat.INCOME - nat.EXPENSE;
  const natureView: NatureView = {
    assets: natAssets,
    liabilities: natLiab,
    equity: natEquity,
    profit: natProfit,
    residual: natAssets - (natLiab + natEquity + natProfit),
  };

  // Unbalanced vouchers (Σdebit ≠ Σcredit within a batch) for this FY.
  const grouped = await prisma.journal.groupBy({
    by: ["batchId"],
    where: { fiscalYearId },
    _sum: { debit: true, credit: true },
  });
  const offenders = grouped
    .filter((g) => g.batchId && Math.abs(Number(g._sum.debit ?? 0) - Number(g._sum.credit ?? 0)) > TOL)
    .map((g) => ({ batchId: g.batchId as string, debit: Number(g._sum.debit ?? 0), credit: Number(g._sum.credit ?? 0) }));
  const voucherNoByBatch = new Map<string, string | null>();
  if (offenders.length) {
    const heads = await prisma.journal.findMany({
      where: { batchId: { in: offenders.map((o) => o.batchId) } },
      select: { batchId: true, voucherNo: true },
      distinct: ["batchId"],
    });
    for (const h of heads) if (h.batchId) voucherNoByBatch.set(h.batchId, h.voucherNo);
  }
  const unbalancedVouchers: UnbalancedVoucher[] = offenders.map((o) => ({
    batchId: o.batchId,
    voucherNo: voucherNoByBatch.get(o.batchId) ?? null,
    debit: o.debit,
    credit: o.credit,
    diff: o.debit - o.credit,
  }));

  const externalInputs = (
    [
      ["Unrealised fair-value loss (OCI)", stmts.external.unrealisedFairValueLoss],
      ["Fair-value receivable adjustment", stmts.external.fairValueReceivableAdjustment],
      ["Mgmt-fee tax at source", stmts.external.mgmtFeeTaxAtSource],
    ] as const
  )
    .filter(([, v]) => Math.abs(v) > TOL)
    .map(([label, amount]) => ({ label, amount }));

  const parts: string[] = [];
  if (Math.abs(bsDiff) <= 1) {
    parts.push("Balance sheet ties (Assets = Equity + Liabilities).");
  } else {
    parts.push(`Balance sheet is OUT by ${bsDiff.toFixed(2)} (Assets − E&L). The trial balance still balances, so the journals are internally consistent — the gap is downstream (mapping / an account on the wrong side).`);
    if (unmappedAccounts.length) {
      parts.push(`${unmappedAccounts.length} account(s) appear on NO statement line (signed ${unmappedTotalSigned.toFixed(2)}) — map them in statement_mapping.ts or fix the name.`);
    }
    const dropped = signAnomalies.filter((a) => a.dropped);
    const harmless = signAnomalies.length - dropped.length;
    if (dropped.length) {
      parts.push(
        `${dropped.length} account(s) are DROPPED from the statements and make up this gap — each sits opposite its normal balance and the mapping reads only the other side, so the balance vanishes: ${dropped.slice(0, 5).map((a) => `${a.name} net-${a.normalBalance === "DEBIT" ? "Cr" : "Dr"} ${a.wrongSide.toFixed(0)}`).join("; ")}. Fix the posting (or map the account).`,
      );
    }
    if (harmless > 0) {
      parts.push(`(${harmless} other wrong-side account(s) are read correctly — only their ChartOfAccount normalBalance flag is mislabelled; harmless.)`);
    }
    if (unclassifiedAccounts.length) {
      parts.push(`${unclassifiedAccounts.length} account(s) have a balance but no AccountGroup — classify them.`);
    }
    if (unbalancedVouchers.length) parts.push(`${unbalancedVouchers.length} voucher(s) don't individually balance (they net out in the TB but each should balance — fix the double-entry).`);
  }

  return {
    tbBalanced: stmts.trialBalance.isBalanced,
    tbDiff: stmts.trialBalance.totals.netDebit - stmts.trialBalance.totals.netCredit,
    bsDiff,
    unmappedAccounts,
    unmappedTotalSigned,
    unclassifiedAccounts,
    signAnomalies,
    natureView,
    unbalancedVouchers,
    externalInputs,
    verdict: parts.join(" "),
  };
}
