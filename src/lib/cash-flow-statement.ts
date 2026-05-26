// Direct-method Statement of Cash Flows (IAS 7).
//
// Reads cash/bank account movements from the journal and classifies the
// counter-account on the OPPOSITE side of each cash leg into Operating /
// Investing / Financing activities and a sub-class (receipts from customers,
// payments to employees, etc.).
//
// Key difference vs /cash-flow (the detail listing): apportionment uses only
// counter-lines on the opposite side of the cash leg (so e.g. a Bank Dr is
// sourced from Cr counter-lines only), and Source Tax / non-cash AIT
// accruals are excluded from apportionment so they don't dilute the
// "Receipts from customers" line.

import { prisma } from "@/lib/prisma";

export type CfsActivity = "OPERATING" | "INVESTING" | "FINANCING";

export type CfsSubClass = {
  activity: CfsActivity;
  /** Display label (e.g. "Receipts from customers"). */
  label: string;
  /** Display order within the activity (lower first). */
  order: number;
  /** Sign convention: receipts are inflows (positive); payments are outflows.
   *  Stored as { inflow, outflow } per sub-class so we can show the gross
   *  legs separately when needed. */
};

export type CfsLine = {
  activity: CfsActivity;
  subClass: string;
  order: number;
  inflow: number;
  outflow: number;
  /** Breakdown by counter-account for drill-down. */
  byAccount: Array<{ accountName: string; inflow: number; outflow: number }>;
};

export type CashFlowStatement = {
  fromDate: Date;
  toDate: Date;
  openingCash: number;
  closingCash: number;
  cashAccounts: string[];
  /** Number of cash-side journal lines processed. */
  cashLineCount: number;
  lines: CfsLine[];
  totals: {
    operatingInflow: number;
    operatingOutflow: number;
    netOperating: number;
    investingInflow: number;
    investingOutflow: number;
    netInvesting: number;
    financingInflow: number;
    financingOutflow: number;
    netFinancing: number;
    netChange: number;
  };
};

// ─── Classifier ──────────────────────────────────────────────────

/** Account names that are NEVER counter-parties to cash even when they
 *  appear in the same batch. Source Tax is an AIT asset accrual at the
 *  moment a mgmt-fee receipt is posted — the bank Dr is the actual cash,
 *  the Source Tax Dr is a non-cash bookkeeping leg. Including it in the
 *  apportionment dilutes Receipts from Customers. */
const NON_CASH_COUNTERS = new Set<string>([
  "Source Tax",
  "AIT Receivables against Management Fee",
  "Deferred Tax",
  "Deferred Tax Expense",
  "Income Tax Expense",
  "Fair Value Reserve",
  "Unrealised Gain/(Loss) on Investments",
  "Accumulated Depreciation-Computers",
  "Accumulated Depreciation-Office Decoration",
  "Depreciation",
]);

/**
 * Classify a counter-account into IAS 7 activity + sub-class. Decisions:
 *
 * - Mgmt fee, advisory fee, formation fee → Receipts from customers
 * - Dividend Income / Dividend Receivable → Dividends received
 * - Interest Income (SND/FDR/Accrued) → Interest received
 * - Capital Gain/Loss/Realised → Realised gain on trading (AMC trading
 *   is core business activity)
 * - Salary, PF, employee TAX, employee allowance → Payments to employees
 * - Provision for income tax, Income Tax Payment, Advance Income TAX
 *   Payment, AIT & VAT Payble → Income taxes paid
 * - Interest on Loan / Margin Loan / Excise on Loan → Interest paid
 *   (kept under operating because for an AMC, loan interest is part of
 *   funding trading positions — core operations)
 * - All other expense accounts → Payments to suppliers (G&A)
 * - Investment in Mutual Fund / share / placement / FDR, broker accounts,
 *   PPE (computers, decoration, equipment), security deposit, IPDC,
 *   Modhumoti as bank-like instruments → Investments (purchase / disposal)
 * - Share Capital, Retained Earning, Margin Loan, Short Term Loan,
 *   IPDC (Loan) → Financing
 * - Liabilities (PF, audit fee, office rent, utility, employee allowance,
 *   AIT) → Operating payments to that counterparty
 * - Catch-all → Other operating, with the account name surfaced for
 *   drill-down
 */
export function classifyAccount(
  accountName: string,
): { activity: CfsActivity; label: string; order: number } {
  const n = accountName;

  // OPERATING — receipts
  if (/^(Management Fee|Advisory Fee|Formation Fee)/i.test(n))
    return { activity: "OPERATING", label: "Receipts from customers (mgmt / advisory fee)", order: 10 };
  if (n === "Management Fee Accrued")
    return { activity: "OPERATING", label: "Receipts from customers (mgmt / advisory fee)", order: 10 };
  if (/^Dividend/i.test(n))
    return { activity: "OPERATING", label: "Dividends received", order: 11 };
  if (/^Interest Income|^Accrued Interest/i.test(n))
    return { activity: "OPERATING", label: "Interest received", order: 12 };
  if (/Capital Gain|Capital Loss|Realised Gain/i.test(n))
    return { activity: "OPERATING", label: "Realised gain on trading", order: 13 };

  // OPERATING — payments
  if (
    /^(Salary|Wages|Employeer Contribution|PF Employeer|Withholding TAX Employees|Ekush Provident)/i.test(
      n,
    ) ||
    /^Liab.*(PF|Employee)/i.test(n)
  )
    return { activity: "OPERATING", label: "Payments to employees", order: 20 };
  if (
    /^(Provision for income tax|Income Tax Payment|Advance Income TAX Payment|AIT & VAT Payble|AIT & VAT on audit fee|Withholding VAT)/i.test(
      n,
    )
  )
    return { activity: "OPERATING", label: "Income taxes paid", order: 21 };
  if (
    /^(Interest on Loan|Interest on Margin|Excise duty on (Loan|FDR)|Other Charges on Loan|Subsidization of loan)/i.test(
      n,
    )
  )
    return { activity: "OPERATING", label: "Interest paid", order: 22 };

  // INVESTING — investments + PPE
  if (
    /^Investment (in|In)/i.test(n) ||
    /^IPO Investment/i.test(n) ||
    /^Computers$|^Office (Decoration|Equipments)$|^Furniture/i.test(n) ||
    /^Software Purchase/i.test(n) ||
    /^Website development/i.test(n) ||
    /^Security Deposit/i.test(n) ||
    /^(ABACI Investment|IDLC Finance Limited|Modhumoti Bank Limited|IPDC Finance Limited|Prime Bank Securities Limited)/i.test(
      n,
    ) ||
    /^Personal Loan to/i.test(n) ||
    /^Receivable for client|^Receivable for clint/i.test(n) ||
    /^Dividend Receivable/i.test(n) ||
    /^Formation Fee Receivable/i.test(n) ||
    /^UCB BO/i.test(n) ||
    /^Advance to BSEC/i.test(n) ||
    /^Advance Tax,Deposits/i.test(n)
  )
    return { activity: "INVESTING", label: "Investments — purchase / disposal", order: 30 };

  // FINANCING
  if (
    /^Share Capital/i.test(n) ||
    /^Retained Earning/i.test(n) ||
    /^Margin Loan/i.test(n) ||
    /^Short Term Loan/i.test(n) ||
    /^IPDC Finance Limited \(Loan\)/i.test(n) ||
    /^Interest payable on loan/i.test(n) ||
    /^Payble to IPDC/i.test(n)
  )
    return { activity: "FINANCING", label: "Capital / borrowings", order: 40 };

  // Default — operating G&A payments / receipts
  return { activity: "OPERATING", label: "Payments to suppliers (G&A)", order: 24 };
}

// ─── Cash-account detection ──────────────────────────────────────

// Same explicit list as the BS "Cash and Cash Equivalents" line —
// src/lib/statement_mapping.ts:474. Keeping these in sync ensures the
// CFS closing cash ties to the BS cash balance.
const CASH_ACCOUNT_NAMES = [
  "Brac (A/C No. 1513204232046001)",
  "Brac Bank (A/C No. 1513204232046002)",
  "Bkash(DM4952)",
  "Midland (A/C No. 00011060000128)",
  "Modhumoti (A/C No. 11351110000092)",
  "Petty Cash",
  "ABACI Investment(C2505)",
  "ABACI Investment",
  "Midland Bank",
] as const;

export async function getCashAccountNames(): Promise<Set<string>> {
  // Filter to active accounts that actually exist in the CoA (so a name
  // typo elsewhere doesn't silently drop a row from the calc).
  const rows = await prisma.chartOfAccount.findMany({
    where: { isActive: true, name: { in: [...CASH_ACCOUNT_NAMES] } },
    select: { name: true },
  });
  return new Set(rows.map((a) => a.name));
}

// ─── Builder ─────────────────────────────────────────────────────

export async function getCashFlowStatement(
  fiscalYearId: string,
  fromDate: Date,
  toDate: Date,
): Promise<CashFlowStatement> {
  const cashNames = await getCashAccountNames();
  const cashArr = Array.from(cashNames);
  if (cashArr.length === 0) {
    return emptyStatement(fromDate, toDate, []);
  }

  // 1. Opening cash = sum of all journal activity on cash accounts strictly
  //    before fromDate. Includes OB.
  const opening = await prisma.journal.aggregate({
    where: {
      accountName: { in: cashArr },
      entryDate: { lt: fromDate },
    },
    _sum: { debit: true, credit: true },
  });
  const openingCash =
    Number(opening._sum.debit ?? 0) - Number(opening._sum.credit ?? 0);

  // 2. Period cash lines.
  const cashLines = await prisma.journal.findMany({
    where: {
      fiscalYearId,
      accountName: { in: cashArr },
      entryDate: { gte: fromDate, lte: toDate },
    },
    select: { batchId: true, accountName: true, debit: true, credit: true },
    take: 10000,
  });

  // 3. Pull counter-lines for the batches that touched cash.
  const batchIds = Array.from(
    new Set(cashLines.map((c) => c.batchId).filter((b): b is string => !!b)),
  );
  const counterLines = batchIds.length
    ? await prisma.journal.findMany({
        where: {
          batchId: { in: batchIds },
          accountName: { notIn: cashArr },
        },
        select: { batchId: true, accountName: true, debit: true, credit: true },
      })
    : [];

  // Group counter-lines by batch.
  const counterByBatch = new Map<
    string,
    Array<{ accountName: string; debit: number; credit: number }>
  >();
  for (const cl of counterLines) {
    if (!cl.batchId) continue;
    const arr = counterByBatch.get(cl.batchId) ?? [];
    arr.push({
      accountName: cl.accountName,
      debit: Number(cl.debit),
      credit: Number(cl.credit),
    });
    counterByBatch.set(cl.batchId, arr);
  }

  // 4. Apportion each cash leg across opposite-side counter-lines and
  //    classify the counter-account.
  const lineMap = new Map<string, CfsLine>(); // key: `${activity}|${label}`
  const getLine = (
    activity: CfsActivity,
    label: string,
    order: number,
  ): CfsLine => {
    const key = `${activity}|${label}`;
    let line = lineMap.get(key);
    if (!line) {
      line = { activity, subClass: label, order, inflow: 0, outflow: 0, byAccount: [] };
      lineMap.set(key, line);
    }
    return line;
  };

  let cashLineCount = 0;

  // Aggregate cash movements per batch first, so any inter-cash transfer
  // within a single voucher (Brac → Midland) nets out before we classify.
  // Then apportion the net cash to non-cash counter-lines on the opposite
  // side (sources of inflow / uses of outflow).
  const netCashByBatch = new Map<string, number>();
  for (const cash of cashLines) {
    if (!cash.batchId) continue;
    const d = Number(cash.debit);
    const c = Number(cash.credit);
    netCashByBatch.set(
      cash.batchId,
      (netCashByBatch.get(cash.batchId) ?? 0) + (d - c),
    );
    cashLineCount++;
  }

  for (const [batchId, netCash] of netCashByBatch) {
    if (Math.abs(netCash) < 0.005) continue; // pure inter-cash transfer

    const counters = counterByBatch.get(batchId) ?? [];
    // Opposite-side filter — for cash inflow (positive netCash), look at
    // counter Cr lines (sources); for outflow, counter Dr lines (uses).
    // Skip non-cash accrual accounts so they don't dilute the
    // apportionment (e.g. Source Tax Dr on a mgmt-fee receipt).
    const oppositeSide = counters.filter((cp) => {
      if (NON_CASH_COUNTERS.has(cp.accountName)) return false;
      if (netCash > 0) return cp.credit > cp.debit;
      return cp.debit > cp.credit;
    });
    const oppositeTotal = oppositeSide.reduce(
      (s, x) => s + Math.abs(x.debit - x.credit),
      0,
    );

    if (oppositeSide.length === 0 || oppositeTotal < 0.005) {
      const line = getLine("OPERATING", "Uncategorised", 90);
      if (netCash > 0) line.inflow += netCash;
      else line.outflow += -netCash;
      continue;
    }

    for (const cp of oppositeSide) {
      const cpNet = Math.abs(cp.debit - cp.credit);
      if (cpNet < 0.005) continue;
      const share = cpNet / oppositeTotal;
      const cls = classifyAccount(cp.accountName);
      const line = getLine(cls.activity, cls.label, cls.order);
      const portion = Math.abs(netCash) * share;
      if (netCash > 0) line.inflow += portion;
      else line.outflow += portion;
      let acc = line.byAccount.find((a) => a.accountName === cp.accountName);
      if (!acc) {
        acc = { accountName: cp.accountName, inflow: 0, outflow: 0 };
        line.byAccount.push(acc);
      }
      if (netCash > 0) acc.inflow += portion;
      else acc.outflow += portion;
    }
  }

  // 5. Closing cash = opening + (Σ cash Dr − Σ cash Cr) over period
  let totalInflow = 0;
  let totalOutflow = 0;
  for (const c of cashLines) {
    totalInflow += Number(c.debit);
    totalOutflow += Number(c.credit);
  }
  const netChange = totalInflow - totalOutflow;
  const closingCash = openingCash + netChange;

  // 6. Totals per activity
  const lines = Array.from(lineMap.values()).sort((a, b) => {
    if (a.activity !== b.activity) {
      const order: Record<CfsActivity, number> = {
        OPERATING: 1,
        INVESTING: 2,
        FINANCING: 3,
      };
      return order[a.activity] - order[b.activity];
    }
    return a.order - b.order;
  });

  // Sort byAccount within each line by magnitude.
  for (const l of lines) {
    l.byAccount.sort(
      (a, b) => b.inflow + b.outflow - (a.inflow + a.outflow),
    );
  }

  const sumActivity = (act: CfsActivity, side: "inflow" | "outflow") =>
    lines
      .filter((l) => l.activity === act)
      .reduce((s, l) => s + l[side], 0);

  const operatingInflow = sumActivity("OPERATING", "inflow");
  const operatingOutflow = sumActivity("OPERATING", "outflow");
  const investingInflow = sumActivity("INVESTING", "inflow");
  const investingOutflow = sumActivity("INVESTING", "outflow");
  const financingInflow = sumActivity("FINANCING", "inflow");
  const financingOutflow = sumActivity("FINANCING", "outflow");

  return {
    fromDate,
    toDate,
    openingCash,
    closingCash,
    cashAccounts: cashArr,
    cashLineCount,
    lines,
    totals: {
      operatingInflow,
      operatingOutflow,
      netOperating: operatingInflow - operatingOutflow,
      investingInflow,
      investingOutflow,
      netInvesting: investingInflow - investingOutflow,
      financingInflow,
      financingOutflow,
      netFinancing: financingInflow - financingOutflow,
      netChange,
    },
  };
}

function emptyStatement(
  fromDate: Date,
  toDate: Date,
  cashAccounts: string[],
): CashFlowStatement {
  return {
    fromDate,
    toDate,
    openingCash: 0,
    closingCash: 0,
    cashAccounts,
    cashLineCount: 0,
    lines: [],
    totals: {
      operatingInflow: 0,
      operatingOutflow: 0,
      netOperating: 0,
      investingInflow: 0,
      investingOutflow: 0,
      netInvesting: 0,
      financingInflow: 0,
      financingOutflow: 0,
      netFinancing: 0,
      netChange: 0,
    },
  };
}
