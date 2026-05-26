// Builds Notes 4.00 – 27.00 from the trial balance + IS/BS + side
// tables (NotesData). Each note function reads what it needs from the
// shared NotesContext and returns rows + total; when the supporting
// data is missing, the function still emits derivable rows and lists
// remaining gaps under `needsInputs` for the page to surface.

import {
  ACCOUNT,
  type TrialBalance,
  type IncomeStatement,
  type BalanceSheet,
  type ExternalInputs,
} from "@/lib/statement_mapping";
import type { AssetClass } from "@/generated/prisma";
import type {
  NotesData,
  OpeningBalances,
  FixedAssetRow,
  ShareholderRow,
  EmployeeDisclosureData,
} from "@/lib/notes-data";

export type NoteRow = {
  label: string;
  /** Numeric value. undefined renders as a placeholder dash. */
  amount?: number;
  /** Indented sub-row. */
  indent?: boolean;
  /** Render in bold above a top-rule (subtotal of a sub-block). */
  subtotal?: boolean;
};

export type Note = {
  /** "04.00", "5.01", "12.02", … as printed in the workbook. */
  number: string;
  title: string;
  /** Cross-reference shown next to the title, e.g. "(Annexure-A)". */
  reference?: string;
  rows: NoteRow[];
  /** Final "Total" line. undefined if the note has no single total. */
  total?: number;
  /** Inputs the note depends on that we couldn't derive. */
  needsInputs?: string[];
};

const netD = (tb: TrialBalance, name: string) => tb.get(name)?.netDebit ?? 0;
const netC = (tb: TrialBalance, name: string) => tb.get(name)?.netCredit ?? 0;
const grossD = (tb: TrialBalance, name: string) => tb.get(name)?.grossDebit ?? 0;
const grossC = (tb: TrialBalance, name: string) => tb.get(name)?.grossCredit ?? 0;
const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

/** Default share count, used only when the Shareholder register is empty. */
const FALLBACK_PAID_UP_SHARES = 6_000_000;
const AUTHORISED_SHARES = 20_000_000;
const SHARE_PAR_BDT = 10;

const ASSET_CLASS_LABEL: Record<AssetClass, string> = {
  computers: "Computers",
  office_decoration: "Office Decoration",
  office_equipment: "Office Equipment",
  other: "Other",
};

export type NotesContext = {
  tb: TrialBalance;
  incomeStatement: IncomeStatement;
  balanceSheet: BalanceSheet;
  external: ExternalInputs;
  data: NotesData;
};

export function buildNotes(ctx: NotesContext): Note[] {
  return [
    note4_PPE(ctx),
    note5_securityDeposit(ctx),
    note6_marketableSecurities(ctx),
    note8_sundryReceivables(ctx),
    note9_cashAndCashEquivalent(ctx),
    note10_advanceTax(ctx),
    note11_shareCapital(ctx),
    note12_retainedEarnings(ctx),
    note12_02_fairValueReserve(ctx),
    note13_incomeTaxExpense(ctx),
    note13_01_deferredTax(ctx),
    note14_provisionForIncomeTax(ctx),
    note15_liabilityForExpenses(ctx),
    note15_01_pfRollforward(ctx),
    note16_managementFees(ctx),
    note17_capitalGainLoss(ctx),
    note18_interestIncome(ctx),
    note19_dividendIncome(ctx),
    note19_01_dividendByStock(ctx),
    note20_interestOnSnd(ctx),
    note21_gaExpenses(ctx),
    note21_01_otherExpenses(ctx),
    note22_depreciation(ctx),
    note23_financialExpenses(ctx),
    note24_unrealisedFairValueLoss(ctx),
    note25_eps(ctx),
    note26_navPerShare(ctx),
    note27_employeesPay(ctx),
  ];
}

/** Total shares from the Shareholder register; falls back to the
 * workbook's 6M when the register is empty. */
function paidUpShares(data: NotesData): number {
  return data.totalSharesIssued > 0 ? data.totalSharesIssued : FALLBACK_PAID_UP_SHARES;
}

function openingDebit(ob: OpeningBalances, name: string): number | undefined {
  return ob.get(name)?.openingDebit;
}
function openingCredit(ob: OpeningBalances, name: string): number | undefined {
  return ob.get(name)?.openingCredit;
}

// ─── Individual notes ────────────────────────────────────────────

function note4_PPE({ tb, data }: NotesContext): Note {
  const wdvFromTb =
    netD(tb, ACCOUNT.computers) +
    netD(tb, ACCOUNT.officeDecoration) +
    netD(tb, ACCOUNT.officeEquipment);
  const totalCost = sum(data.fixedAssets.map((a) => a.cost));
  const totalAccDepr = sum(data.fixedAssets.map((a) => a.accumulatedDepreciation));
  const wdv = data.fixedAssets.length > 0 ? totalCost - totalAccDepr : wdvFromTb;

  const rows: NoteRow[] = data.fixedAssets.length === 0
    ? [
        { label: "At Cost", amount: undefined },
        { label: "Less: Accumulated Depreciation", amount: undefined },
        { label: "Written Down Value (from TB)", amount: wdvFromTb, subtotal: true },
      ]
    : [
        { label: "At Cost", amount: totalCost },
        { label: "Less: Accumulated Depreciation", amount: totalAccDepr },
        { label: "Written Down Value", amount: wdv, subtotal: true },
      ];

  return {
    number: "04.00",
    title: "Property, Plant and Equipments",
    reference: "(Annexure-A)",
    rows,
    total: wdv,
    needsInputs: data.fixedAssets.length === 0
      ? ["PPE register entries in `fixed_assets` table"]
      : undefined,
  };
}

function note5_securityDeposit({ tb }: NotesContext): Note {
  const officeRent = netD(tb, ACCOUNT.securityDepositOfficeRent);
  return {
    number: "5.01",
    title: "Security Deposit",
    rows: [{ label: "Office Rent", amount: officeRent }],
    total: officeRent,
  };
}

function note6_marketableSecurities({ tb }: NotesContext): Note {
  const efuf = netD(tb, ACCOUNT.investmentEfuf);
  const egf = netD(tb, ACCOUNT.investmentEgf);
  const esrf = netD(tb, ACCOUNT.investmentSrf);
  const listed = netD(tb, ACCOUNT.investmentInShare);
  const placement = netD(tb, ACCOUNT.investmentInPlacementShares);
  const ipo = netD(tb, ACCOUNT.ipoInvestment);
  const total = efuf + egf + esrf + listed + placement + ipo;
  return {
    number: "06.00",
    title: "Investment in Marketable Securities",
    reference: "(Annexure-B)",
    rows: [
      { label: "Ekush First Unit Fund", amount: efuf },
      { label: "Ekush Growth Fund", amount: egf },
      { label: "Ekush Stable Return Fund", amount: esrf },
      { label: "Investment in Listed Securities", amount: listed },
      { label: "Investment in Placement Shares", amount: placement },
      { label: "IPO Investment", amount: ipo },
    ],
    total,
  };
}

function note8_sundryReceivables({ tb, external }: NotesContext): Note {
  const accruedFdrInterest = netD(tb, ACCOUNT.accruedInterestOnFdr);
  const dividend = netD(tb, ACCOUNT.dividendReceivable);
  const mgmtFee = netD(tb, ACCOUNT.managementFeeAccrued);
  const formationFee = netD(tb, ACCOUNT.formationFeeReceivableEsrf);
  const hsbc = netD(tb, ACCOUNT.receivableForClientHsbc);
  const commission = netD(tb, ACCOUNT.commission);
  const fvAdj = external.fairValueReceivableAdjustment;
  const total =
    accruedFdrInterest + dividend + mgmtFee + formationFee + hsbc + commission + fvAdj;
  return {
    number: "08.00",
    title: "Sundry Receivables",
    rows: [
      { label: "Accrued Interest on FDR", amount: accruedFdrInterest },
      { label: "Management Fee Accrued", amount: mgmtFee },
      { label: "Dividend Receivable", amount: dividend },
      { label: "Formation Fee Receivable from ESRF", amount: formationFee },
      { label: "Receivable for Client (HSBC)", amount: hsbc },
      { label: "Commission", amount: commission },
      { label: "Fair Value Adjustment (Annexure!M131)", amount: fvAdj },
    ],
    total,
  };
}

function note9_cashAndCashEquivalent({ tb }: NotesContext): Note {
  const rows: Array<[string, number]> = [
    ["Brac Bank (A/C No. 1513204232046001)", netD(tb, ACCOUNT.bracBank1)],
    ["Brac Bank (A/C No. 1513204232046002)", netD(tb, ACCOUNT.bracBank2)],
    ["Midland (A/C No. 00011060000128)", netD(tb, ACCOUNT.midland)],
    ["Modhumoti Bank (A/C No. 11351110000092)", netD(tb, ACCOUNT.modhumotiAccount)],
    ["Petty Cash", netD(tb, ACCOUNT.pettyCash)],
    ["Bkash (DM4952)", netD(tb, ACCOUNT.bkash)],
    ["ABACI Investment (C2505)", netD(tb, ACCOUNT.abaciInvestmentC2505)],
    ["ABACI Investment", netD(tb, ACCOUNT.abaciInvestment)],
    ["Midland Bank", netD(tb, ACCOUNT.midlandBank)],
  ];
  const total = sum(rows.map(([, v]) => v));
  return {
    number: "09.00",
    title: "Cash and Cash Equivalent",
    rows: rows.map(([label, amount]) => ({ label, amount })),
    total,
  };
}

function note10_advanceTax({ tb, data }: NotesContext): Note {
  const closing =
    netD(tb, ACCOUNT.advanceTaxDepositsPrepayments) +
    netD(tb, ACCOUNT.sourceTax) +
    netD(tb, ACCOUNT.advanceIncomeTaxPayment) +
    netD(tb, ACCOUNT.advanceToBsec);
  const opening = openingDebit(data.openingBalances, ACCOUNT.advanceTaxDepositsPrepayments);
  // Period activity = closing - opening (when opening is known).
  const period = opening === undefined ? undefined : closing - opening;
  return {
    number: "10.00",
    title: "Advance Tax, Deposits and Prepayments",
    rows: [
      { label: "Tax Deducted at Source", subtotal: true },
      { label: "Opening Balance", indent: true, amount: opening },
      { label: "Net Activity during the Year", indent: true, amount: period },
      { label: "Closing Balance (from TB)", amount: closing, subtotal: true },
    ],
    total: closing,
    needsInputs:
      opening === undefined
        ? ["Opening balance row in `account_opening_balances` for 'Advance Tax,Deposits and prepayments'"]
        : undefined,
  };
}

function note11_shareCapital({ tb, data }: NotesContext): Note {
  const paidUpFromTb = netC(tb, ACCOUNT.shareCapital);
  const shareholders = data.shareholders;
  const totalShares = paidUpShares(data);
  const paidUpFromRegister = totalShares * SHARE_PAR_BDT;

  const rows: NoteRow[] = [
    {
      label: `Authorised: ${AUTHORISED_SHARES.toLocaleString("en-IN")} Ordinary Shares of Tk. ${SHARE_PAR_BDT.toFixed(2)} each`,
      amount: AUTHORISED_SHARES * SHARE_PAR_BDT,
    },
    {
      label: `Issued, Subscribed and Paid-up: ${totalShares.toLocaleString("en-IN")} Ordinary Shares of Tk. ${SHARE_PAR_BDT.toFixed(2)} each`,
      amount: paidUpFromRegister || paidUpFromTb,
      subtotal: true,
    },
  ];

  if (shareholders.length > 0) {
    rows.push({ label: "Name of the Shareholders", subtotal: true });
    for (const s of shareholders) {
      rows.push({
        label: `${s.fullName} — ${s.sharesHeld.toLocaleString("en-IN")} shares`,
        indent: true,
        amount: s.sharesHeld * SHARE_PAR_BDT,
      });
    }
  }

  return {
    number: "11.00",
    title: "Share Capital",
    rows,
    total: paidUpFromRegister || paidUpFromTb,
    needsInputs:
      shareholders.length === 0 ? ["Shareholder rows in `shareholders` table"] : undefined,
  };
}

function note12_retainedEarnings({ tb, incomeStatement, data }: NotesContext): Note {
  const opening = openingCredit(data.openingBalances, ACCOUNT.retainedEarning);
  const tbBalance = netC(tb, ACCOUNT.retainedEarning);
  // Anything posted to retained earnings DURING the FY (e.g. prior-year
  // adjustments) shows up as `tbBalance - opening`.
  const priorYearAdj = opening === undefined ? undefined : tbBalance - opening;
  const closing = tbBalance + incomeStatement.profitForPeriod;
  return {
    number: "12.00",
    title: "Retained Earnings",
    rows: [
      { label: "Opening Balance", amount: opening },
      { label: "Add: Prior Year Adjustment / movements", amount: priorYearAdj },
      { label: "Add: Profit for the Period (per IS)", amount: incomeStatement.profitForPeriod },
      { label: "Closing Balance", amount: closing, subtotal: true },
    ],
    total: closing,
    needsInputs:
      opening === undefined
        ? ["Opening balance row for 'Retained Earning' in `account_opening_balances`"]
        : undefined,
  };
}

function note12_02_fairValueReserve({ tb, incomeStatement, data }: NotesContext): Note {
  const closing = netC(tb, ACCOUNT.fairValueReserve);
  const opening = openingCredit(data.openingBalances, ACCOUNT.fairValueReserve);
  const ociFv = incomeStatement.oci.find((l) => /Unrealised/i.test(l.label))?.amount ?? 0;
  const ociDt = incomeStatement.oci.find((l) => /Deferred Tax/i.test(l.label))?.amount ?? 0;
  return {
    number: "12.02",
    title: "Fair Value Reserve",
    rows: [
      { label: "Opening Balance", amount: opening },
      { label: "Fair Value Gain/(Loss) on Investment in Shares", amount: ociFv },
      { label: "Deferred Tax", amount: ociDt },
      { label: "Closing Balance (from TB)", amount: closing, subtotal: true },
    ],
    total: closing,
    needsInputs:
      opening === undefined
        ? ["Opening balance row for 'Fair Value Reserve' in `account_opening_balances`"]
        : undefined,
  };
}

function note13_incomeTaxExpense({ incomeStatement }: NotesContext): Note {
  const currentTax = sum(incomeStatement.taxExpense.map((l) => l.amount));
  const deferredTax = incomeStatement.oci.find((l) => /Deferred Tax/i.test(l.label))?.amount ?? 0;
  const total = currentTax + deferredTax;
  return {
    number: "13.00",
    title: "Income Tax Expenses",
    rows: [
      { label: "Current Tax Provision", amount: currentTax },
      { label: "Add: Deferred Tax Income/(Expenses)", amount: deferredTax },
    ],
    total,
  };
}

function note13_01_deferredTax({ data, incomeStatement }: NotesContext): Note {
  const snap = data.latestTaxProvision;

  // No POSTED TaxProvision row yet for this FY — fall back to the
  // computed values that still live on the IS, but flag the absence
  // so the auditor sees this is a draft view.
  if (!snap) {
    const ociFv = incomeStatement.oci.find((l) => /Unrealised/i.test(l.label))?.amount ?? 0;
    const deferredTax = incomeStatement.oci.find((l) => /Deferred Tax/i.test(l.label))?.amount ?? 0;
    return {
      number: "13.01",
      title: "Tax Expense Computation",
      rows: [
        { label: "Fair Value Gain/(Loss) — accounting base", amount: ociFv },
        { label: "Deferred Tax (per OCI)", amount: deferredTax, subtotal: true },
      ],
      total: deferredTax,
      needsInputs: [
        "Tax provision has not been posted yet for this fiscal year. Open /admin/tax-provision and click 'Post to Ledger' to freeze the per-rate breakdown.",
      ],
    };
  }

  // Posted snapshot — render the full per-rate computation.
  const r = snap.ratesSnapshot;
  const b = snap.basesSnapshot;
  const rows: NoteRow[] = [
    { label: "─ Current Tax", subtotal: true },
    { label: "Capital Gain — net (Note 17)", amount: b.capitalGainNet, indent: true },
    { label: `× Capital Gain Tax Rate (${(r.CAPITAL_GAIN * 100).toFixed(2)}%)`, indent: true },
    { label: "Tax on Capital Gain", amount: snap.currentTaxCg, indent: true },
    { label: "Dividend Income (Note 19)", amount: b.dividendIncome, indent: true },
    { label: `× Dividend Tax Rate (${(r.DIVIDEND * 100).toFixed(2)}%)`, indent: true },
    { label: "Tax on Dividend Income", amount: snap.currentTaxDividend, indent: true },
    { label: "Interest Income (Note 18)", amount: b.interestIncomeTotal, indent: true },
    { label: `× Interest Tax Rate (${(r.INTEREST * 100).toFixed(2)}%)`, indent: true },
    { label: "Tax on Interest (net of interest expense)", amount: snap.currentTaxInterest, indent: true },
    { label: "Mgmt Fee TDS (at source)", amount: snap.currentTaxMgmt, indent: true },
    {
      label: `× Corporate Tax Rate (${(r.CORPORATE * 100).toFixed(2)}%) on business income (net)`,
      indent: true,
    },
    { label: "Tax on Business Income", amount: snap.currentTaxBusiness, indent: true },
    { label: "Σ Current Tax", amount: snap.currentTaxTotal, subtotal: true },
    { label: "─ Deferred Tax (OCI)", subtotal: true },
    { label: "Change in Unrealised Fair Value (Note 24)", amount: b.fairValueChange, indent: true },
    { label: `× Deferred Tax Rate (${(r.DEFERRED * 100).toFixed(2)}%)`, indent: true },
    { label: "Σ Deferred Tax", amount: snap.deferredTaxTotal, subtotal: true },
  ];

  return {
    number: "13.01",
    title: "Tax Expense Computation",
    reference: `Snapshot computed ${snap.computedAt.toISOString().slice(0, 10)} — see /admin/tax-provision history`,
    rows,
    total: snap.currentTaxTotal + snap.deferredTaxTotal,
  };
}

function note14_provisionForIncomeTax({ tb, data }: NotesContext): Note {
  // Phase 4 of the Tax Provision module: the Tax Provision card posts
  // the period charge directly onto the Provision for Income Tax
  // account, so netC alone is the closing balance. The previous
  // `+ external.currentPeriodTaxExpense` line double-counted once
  // posting was in place — dropped.
  const closing = netC(tb, ACCOUNT.provisionForIncomeTax);
  const opening = openingCredit(data.openingBalances, ACCOUNT.provisionForIncomeTax);
  // Signed period activity on the account: positive = period
  // accrual (Cr), negative = settlement/payment (Dr). Phase 5 will
  // split these into separate rows; for now show the net.
  const periodCharge =
    grossC(tb, ACCOUNT.provisionForIncomeTax) - grossD(tb, ACCOUNT.provisionForIncomeTax);
  return {
    number: "14.00",
    title: "Provision for Income Tax",
    rows: [
      { label: "Opening Balance", amount: opening },
      { label: "Add: Period activity (current-tax accrual − settlements)", amount: periodCharge },
      { label: "Closing Balance (from TB)", amount: closing, subtotal: true },
    ],
    total: closing,
    needsInputs:
      opening === undefined
        ? ["Opening balance row for 'Provision for income tax' in `account_opening_balances`"]
        : undefined,
  };
}

function note15_liabilityForExpenses({ tb }: NotesContext): Note {
  const utility = netC(tb, ACCOUNT.liabUtilityExp);
  const auditAccrued = netC(tb, ACCOUNT.auditFeeAccrued);
  const auditPayable = netC(tb, ACCOUNT.liabilityAuditFee);
  const tdsVat =
    netC(tb, ACCOUNT.withholdingVatAndTds) + netC(tb, ACCOUNT.withholdingTaxEmployees);
  const pf = grossC(tb, ACCOUNT.liabForPfFund);
  const employee = netC(tb, ACCOUNT.liabForEmployeeAllowance);
  const rent = netC(tb, ACCOUNT.liabOfficeRent);
  const total = utility + auditAccrued + auditPayable + tdsVat + pf + employee + rent;
  return {
    number: "15.00",
    title: "Liability for Expenses",
    rows: [
      { label: "Utility Expenses Payable", amount: utility },
      { label: "Audit Fee (Accrued)", amount: auditAccrued },
      { label: "Audit Fee Payable", amount: auditPayable },
      { label: "Withholding VAT & TDS / Tax (Employees)", amount: tdsVat },
      { label: "Liability for PF Fund", amount: pf },
      { label: "Liability for Employee Allowance", amount: employee },
      { label: "Liability for Office Rent", amount: rent },
    ],
    total,
  };
}

function note15_01_pfRollforward({ tb, data }: NotesContext): Note {
  const closing = grossC(tb, ACCOUNT.liabForPfFund);
  const opening = openingCredit(data.openingBalances, ACCOUNT.liabForPfFund);
  return {
    number: "15.01",
    title: "Employer Contribution to Provident Fund",
    rows: [
      { label: "Opening Balance", amount: opening },
      { label: "Movement during the year", amount: opening === undefined ? undefined : closing - opening },
      { label: "Closing Balance (from TB, gross credit)", amount: closing, subtotal: true },
    ],
    total: closing,
    needsInputs:
      opening === undefined
        ? ["Opening balance row for 'Liab: For PF Fund' in `account_opening_balances`"]
        : undefined,
  };
}

function note16_managementFees({ tb, data }: NotesContext): Note {
  const total = netC(tb, ACCOUNT.managementFee);
  const splits = data.fundManagementFees;
  const rows: NoteRow[] = [];
  // Standard fund order
  for (const [code, label] of [
    ["EFUF", "Ekush First Unit Fund"],
    ["EGF", "Ekush Growth Fund"],
    ["ESRF", "Ekush Stable Return Fund"],
  ] as const) {
    rows.push({ label, amount: splits.has(code) ? splits.get(code) : undefined });
  }
  // Any other fundCodes present in journals
  for (const [code, amount] of splits) {
    if (code === "EFUF" || code === "EGF" || code === "ESRF") continue;
    rows.push({ label: `Fund: ${code}`, amount });
  }
  rows.push({ label: "Total Management Fee (from TB)", amount: total, subtotal: true });
  return {
    number: "16.00",
    title: "Management Fees",
    rows,
    total,
    needsInputs:
      splits.size === 0
        ? ["Set `fundCode` on management-fee journal lines (EFUF / EGF / ESRF)"]
        : undefined,
  };
}

function note17_capitalGainLoss({ tb, data }: NotesContext): Note {
  const total = grossC(tb, ACCOUNT.capitalGain) - grossD(tb, ACCOUNT.capitalLoss);
  const splits = data.fundCapitalGains;
  const rows: NoteRow[] = [];
  for (const [code, label] of [
    ["EFUF", "Ekush First Unit Fund"],
    ["EGF", "Ekush Growth Fund"],
    ["ESRF", "Ekush Stable Return Fund"],
    ["LISTED", "Listed Securities"],
  ] as const) {
    rows.push({ label, amount: splits.has(code) ? splits.get(code) : undefined });
  }
  for (const [code, amount] of splits) {
    if (["EFUF", "EGF", "ESRF", "LISTED"].includes(code)) continue;
    rows.push({ label: `Fund: ${code}`, amount });
  }
  rows.push({ label: "Total Capital Gain (from TB)", amount: total, subtotal: true });
  return {
    number: "17.00",
    title: "Capital Gain/(Loss)",
    rows,
    total,
    needsInputs:
      splits.size === 0
        ? ["Set `fundCode` on capital-gain / capital-loss journal lines"]
        : undefined,
  };
}

function note18_interestIncome({ tb }: NotesContext): Note {
  const interestOnSnd = netC(tb, ACCOUNT.interestIncome);
  const interestOnFdr =
    grossC(tb, ACCOUNT.interestIncomeOfFdr) - grossD(tb, ACCOUNT.interestIncomeOfFdr);
  const total = interestOnSnd + interestOnFdr;
  return {
    number: "18.00",
    title: "Interest Income",
    rows: [
      { label: "Interest on SND", amount: interestOnSnd },
      { label: "Interest on FDR", amount: interestOnFdr },
    ],
    total,
  };
}

function note19_dividendIncome({ tb }: NotesContext): Note {
  const dividend = netC(tb, ACCOUNT.dividendIncome);
  return {
    number: "19.00",
    title: "Dividend Income",
    rows: [{ label: "Dividend Received During the Year", amount: dividend }],
    total: dividend,
  };
}

function note19_01_dividendByStock({ data }: NotesContext): Note {
  const splits = data.dividendByInstrument;
  const STANDARD_TICKERS = [
    "BATBC",
    "BRACBANK",
    "BSCPLC",
    "RENATA",
    "EFUF",
    "EGF",
    "SUBMARINE",
    "ASIATIC_LAB",
  ] as const;
  const rows: NoteRow[] = STANDARD_TICKERS.map((ticker) => ({
    label: ticker,
    amount: splits.has(ticker) ? splits.get(ticker) : undefined,
  }));
  for (const [code, amount] of splits) {
    if ((STANDARD_TICKERS as readonly string[]).includes(code)) continue;
    rows.push({ label: code, amount });
  }
  const total = [...splits.values()].reduce((s, v) => s + v, 0);
  rows.push({ label: "Total Dividend by Instrument", amount: total, subtotal: true });
  return {
    number: "19.01",
    title: "Dividend Income Received (per investment)",
    rows,
    total,
    needsInputs:
      splits.size === 0
        ? ["Set `instrumentCode` (stock ticker) on dividend-income journal lines"]
        : undefined,
  };
}

function note20_interestOnSnd({ tb, data }: NotesContext): Note {
  const total = netC(tb, ACCOUNT.interestIncome);
  const splits = data.interestByInstrument;
  const rows: NoteRow[] = [];
  for (const code of [
    "BRACBANK_1513204232046001",
    "BRACBANK_1513204232046002",
    "MIDLAND_0001-1060000128",
  ]) {
    rows.push({ label: code, amount: splits.has(code) ? splits.get(code) : undefined });
  }
  for (const [code, amount] of splits) {
    if (
      [
        "BRACBANK_1513204232046001",
        "BRACBANK_1513204232046002",
        "MIDLAND_0001-1060000128",
      ].includes(code)
    ) continue;
    rows.push({ label: code, amount });
  }
  rows.push({ label: "Total Interest Income (from TB)", amount: total, subtotal: true });
  return {
    number: "20.00",
    title: "Interest on SND A/C",
    rows,
    total,
    needsInputs:
      splits.size === 0
        ? ["Set `instrumentCode` (bank-account code) on interest-income journal lines"]
        : undefined,
  };
}

function note21_gaExpenses({ tb }: NotesContext): Note {
  const rows: Array<[string, number]> = [
    ["Salary and Allowances", netD(tb, ACCOUNT.salaryAndAllowances)],
    ["Contribution to Provident Fund", grossD(tb, ACCOUNT.employeerContributionForPf)],
    ["Wages", netD(tb, ACCOUNT.wages)],
    ["Audit Fee", netD(tb, ACCOUNT.auditFee)],
    ["AGM and Meeting Expense", netD(tb, ACCOUNT.agmExpense) + netD(tb, ACCOUNT.boardMeetingExpenses)],
    ["Advertisement", netD(tb, ACCOUNT.advertisement)],
    ["Membership Fee", netD(tb, ACCOUNT.membershipExpenses)],
    ["IT Expense", netD(tb, ACCOUNT.itExpense)],
    ["Selling Agent Fee", netD(tb, ACCOUNT.sellingAgentFees)],
    ["Registration, Licence & Renewal Fees", netD(tb, ACCOUNT.registrationLicenseRenewalFees)],
    ["BSEC Application Fee", netD(tb, ACCOUNT.bsecApplicationFee)],
    ["Internet Bill", netD(tb, ACCOUNT.internetBill)],
    ["Repair & Maintenance", netD(tb, ACCOUNT.repairAndMaintenance)],
    ["Office Rent", netD(tb, ACCOUNT.rent)],
    ["Utility Expense", netD(tb, ACCOUNT.utilityExpense)],
    ["Printing and Stationery", netD(tb, ACCOUNT.printingExpense) + netD(tb, ACCOUNT.stationary)],
    ["Office Expenses", netD(tb, ACCOUNT.officeExpenses)],
    ["Website Development", netD(tb, ACCOUNT.websiteDevelopment)],
    ["Entertainment", netD(tb, ACCOUNT.entertainment)],
    ["Travelling & Conveyance", netD(tb, ACCOUNT.conveyanceBill)],
    ["Business Development Expenses", netD(tb, ACCOUNT.businessDevelopmentExpenses)],
    ["Flood Relief", netD(tb, ACCOUNT.floodRelife)],
    ["RJSC Expenses", netD(tb, ACCOUNT.rjscExpense)],
    ["Commission", netD(tb, ACCOUNT.commission)],
    ["Depreciation (Note: 22.00)", netD(tb, ACCOUNT.depreciation)],
    ["Other Expenses (Note: 21.01)", subOtherExpenses(tb)],
  ];
  const total = sum(rows.map(([, v]) => v));
  return {
    number: "21.00",
    title: "General and Administrative Expenses",
    rows: rows.map(([label, amount]) => ({ label, amount })),
    total,
  };
}

function subOtherExpenses(tb: TrialBalance): number {
  return (
    netD(tb, ACCOUNT.officeMaintenance) +
    netD(tb, ACCOUNT.courierCharge) +
    netD(tb, ACCOUNT.payOrder) +
    netD(tb, ACCOUNT.miscellaneousExpenses) +
    netD(tb, ACCOUNT.biddingFee) +
    netD(tb, ACCOUNT.mobileBill) +
    netD(tb, ACCOUNT.trainingFee)
  );
}

function note21_01_otherExpenses({ tb }: NotesContext): Note {
  const rows: Array<[string, number]> = [
    ["Office Maintenance", netD(tb, ACCOUNT.officeMaintenance)],
    ["Courier Charges", netD(tb, ACCOUNT.courierCharge)],
    ["Pay Order", netD(tb, ACCOUNT.payOrder)],
    ["Miscellaneous Expenses", netD(tb, ACCOUNT.miscellaneousExpenses)],
    ["IPO Bidding Fees", netD(tb, ACCOUNT.biddingFee)],
    ["Mobile Bill and Telephone Bill", netD(tb, ACCOUNT.mobileBill)],
    ["Training Fee", netD(tb, ACCOUNT.trainingFee)],
  ];
  const total = sum(rows.map(([, v]) => v));
  return {
    number: "21.01",
    title: "Other Expenses",
    rows: rows.map(([label, amount]) => ({ label, amount })),
    total,
  };
}

function note22_depreciation({ tb, data }: NotesContext): Note {
  const totalFromTb = netD(tb, ACCOUNT.depreciation);
  // Per-class period depreciation from the PPE register.
  const byClass = new Map<AssetClass, number>();
  for (const a of data.fixedAssets) {
    byClass.set(a.assetClass, (byClass.get(a.assetClass) ?? 0) + a.periodDepreciation);
  }
  const totalFromRegister = sum([...byClass.values()]);
  const hasRegister = data.fixedAssets.length > 0;

  const rows: NoteRow[] = (
    ["computers", "office_decoration", "office_equipment", "other"] as AssetClass[]
  ).map((cls) => ({
    label: `Depreciation — ${ASSET_CLASS_LABEL[cls]}`,
    amount: hasRegister ? (byClass.get(cls) ?? 0) : undefined,
  }));
  if (hasRegister) {
    rows.push({ label: "Total (from PPE register)", amount: totalFromRegister, subtotal: true });
  }
  rows.push({ label: "Total Depreciation (from TB)", amount: totalFromTb, subtotal: true });

  return {
    number: "22.00",
    title: "Depreciation",
    rows,
    total: totalFromTb,
    needsInputs: !hasRegister
      ? ["Per-asset depreciation rows in `fixed_asset_depreciations` for this fiscal year"]
      : undefined,
  };
}

function note23_financialExpenses({ tb }: NotesContext): Note {
  const bankCharge = netD(tb, ACCOUNT.bankCharge);
  const exciseDuty = netD(tb, ACCOUNT.exciseDuty);
  const interestOnMargin =
    grossD(tb, ACCOUNT.interestOnMarginLoan) +
    (grossD(tb, ACCOUNT.interestExpense) - grossC(tb, ACCOUNT.interestExpense));
  const total = bankCharge + exciseDuty + interestOnMargin;
  return {
    number: "23.00",
    title: "Financial Expenses",
    rows: [
      { label: "Bank Charge", amount: bankCharge },
      { label: "Excise Duty", amount: exciseDuty },
      { label: "Interest on Margin Loan", amount: interestOnMargin },
    ],
    total,
  };
}

function note24_unrealisedFairValueLoss({ external, data }: NotesContext): Note {
  const closing = external.unrealisedFairValueLoss;
  const opening = openingCredit(data.openingBalances, "Fair Value Reserve");
  const period = opening === undefined ? undefined : closing - opening;
  return {
    number: "24.00",
    title: "Unrealised Gain/(Loss) due to change in fair value",
    rows: [
      { label: "Opening Balance", amount: opening },
      { label: "Closing Balance (from Annexure-B unrealised loss)", amount: closing },
      { label: "Period Income/(Expenses)", amount: period },
    ],
    total: closing,
    needsInputs:
      opening === undefined
        ? ["Opening balance row for 'Fair Value Reserve' in `account_opening_balances`"]
        : undefined,
  };
}

function note25_eps({ incomeStatement, data }: NotesContext): Note {
  const shares = paidUpShares(data);
  const eps = incomeStatement.profitForPeriod / shares;
  return {
    number: "25.00",
    title: "Earnings Per Share (EPS)",
    rows: [
      { label: "Net Profit/(Loss) after Tax", amount: incomeStatement.profitForPeriod },
      {
        label: `Number of Ordinary Shares (${shares.toLocaleString("en-IN")}${data.totalSharesIssued === 0 ? " — fallback" : ""})`,
        amount: shares,
      },
      { label: "Earnings Per Share (BDT)", amount: eps, subtotal: true },
    ],
    total: eps,
    needsInputs:
      data.totalSharesIssued === 0
        ? ["Shareholders register populated — currently using fallback 6,000,000 shares"]
        : undefined,
  };
}

function note26_navPerShare({ balanceSheet, data }: NotesContext): Note {
  const shares = paidUpShares(data);
  const totalLiabilities =
    sum(balanceSheet.nonCurrentLiabilities.map((l) => l.amount)) +
    sum(balanceSheet.currentLiabilities.map((l) => l.amount));
  const nav = balanceSheet.totalAssets - totalLiabilities;
  const navPerShare = nav / shares;
  return {
    number: "26.00",
    title: "Net Asset Value (NAV) Per Share",
    rows: [
      { label: "Total Assets", amount: balanceSheet.totalAssets },
      { label: "Less: Total Outstanding Liabilities", amount: totalLiabilities },
      { label: "Total Net Assets Value (NAV) at Cost Price", amount: nav, subtotal: true },
      {
        label: `Number of Ordinary Shares (${shares.toLocaleString("en-IN")}${data.totalSharesIssued === 0 ? " — fallback" : ""})`,
        amount: shares,
      },
      { label: "NAV Per Share (BDT)", amount: navPerShare, subtotal: true },
    ],
    total: navPerShare,
    needsInputs:
      data.totalSharesIssued === 0
        ? ["Shareholders register populated — currently using fallback 6,000,000 shares"]
        : undefined,
  };
}

function note27_employeesPay({ data }: NotesContext): Note {
  const e = data.employeeDisclosure;
  return {
    number: "27.00",
    title: "Employees Minimum Pay Disclosure",
    rows: [
      { label: "Total Number of Employees", amount: e?.totalEmployees },
      { label: "Employees earning below minimum wage", amount: e?.belowMinimumWage },
      { label: "Minimum monthly salary paid (BDT)", amount: e?.minMonthlySalaryBdt },
    ],
    needsInputs: e === null ? ["Row in `employee_disclosures` for this fiscal year"] : undefined,
  };
}

// Re-exports for callers that still use the old explicit-args shape.
export type { ShareholderRow, FixedAssetRow, EmployeeDisclosureData };
