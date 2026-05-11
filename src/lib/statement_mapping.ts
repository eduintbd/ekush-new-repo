// Maps the line items on the Income Statement, Balance Sheet, and Statement
// of Changes in Equity to chart-of-accounts names + aggregation rule.
//
// Source of truth: F.S March 2026.xlsx, sheets BS./IS./CE/Notes. Each rule
// below cites the spec §5.11 cell-ref formula it replaces and the row in
// TB-C the cell ref points at (verified against the workbook's TB-C col G,
// rowCount=135, account list starting r7).
//
// Rules of the road:
// - Account names use the spelling as it appears in TB-C col G of the
//   workbook (the names the SUMIFS formulas filter on). 14 of these
//   diverge from CHART_OF_ACCOUNTS_SEED — see WORKBOOK_NAME_DISCREPANCIES
//   below. Resolve before posting any journals against those accounts.
// - When an account has both debit and credit activity in the period, K
//   (net debit) and L (net credit) are mutually exclusive: K = max(0, ΣH−ΣI),
//   L = max(0, ΣI−ΣH). The spec sometimes uses gross H/I instead — those
//   formulas use grossDebit / grossCredit helpers and are commented inline.
//
// KNOWN WORKBOOK ISSUE (March 2026): the source workbook's IS!H24 pulls tax
// from `'[6]Notes. (2)'!F12` — a STALE EXTERNAL workbook reference (link 6),
// not the local Notes. (2). The local Notes. (2)!F12 = ₹19.07 L (correct
// current-period provision computed from Capital Gain × 15% + Dividend × 20%
// + source tax on Mgmt Fee). The external (cached) value = ₹6.01 L. We use
// the local correctly-computed value; the workbook's IS tax line is wrong.
// As a result, our Provision for Income Tax = ₹38.95 L vs workbook ₹25.89 L.
// Both balance internally — only the magnitude differs.

// ─── Inputs ──────────────────────────────────────────────────────

/** Per-account aggregates over the reporting period, derived from journals. */
export type AccountAggregate = {
  grossDebit: number;
  grossCredit: number;
  /** max(grossDebit − grossCredit, 0) — TB-C col K. */
  netDebit: number;
  /** max(grossCredit − grossDebit, 0) — TB-C col L. */
  netCredit: number;
};

/** Map keyed by chart_of_accounts.name (TB-C col G spelling). */
export type TrialBalance = Map<string, AccountAggregate>;

/** Inputs that don't come from the trial balance. */
export type ExternalInputs = {
  /** Annexure march!K27 — unrealised loss on listed shares (positive amount). */
  unrealisedFairValueLoss: number;
  /** Notes.(2)!F12 — current-tax provision for the period. */
  currentTaxProvision: number;
  /** Annexure!M131 — fair-value adjustment to sundry receivables. */
  fairValueReceivableAdjustment: number;
  /** Used only by BS Retained Earnings line: net profit from the period IS. */
  currentPeriodNetProfit: number;
  /** Used only by BS Provision for Income Tax line: IS!H24 income-tax expense. */
  currentPeriodTaxExpense: number;
};

// ─── Helpers ─────────────────────────────────────────────────────

const grossD = (tb: TrialBalance, name: string) => tb.get(name)?.grossDebit ?? 0;
const grossC = (tb: TrialBalance, name: string) => tb.get(name)?.grossCredit ?? 0;
const netD = (tb: TrialBalance, name: string) => tb.get(name)?.netDebit ?? 0;
const netC = (tb: TrialBalance, name: string) => tb.get(name)?.netCredit ?? 0;

const sumNetD = (tb: TrialBalance, names: readonly string[]) =>
  names.reduce((s, n) => s + netD(tb, n), 0);

// ─── Account names (TB-C col G canonical spelling) ───────────────

/** Every account name referenced by IS / BS / CE / Notes mappings. */
export const ACCOUNT = {
  // Property, Plant & Equipment (TB-C r7–r9)
  computers: "Computers",
  officeDecoration: "Office Decoration",
  officeEquipment: "Office Equipment",

  // Investments (TB-C r10–r15, r29–r30)
  investmentEfuf: "Investment in Mutual Fund(E.F.U.F)",
  investmentInShare: "Investment in share",
  investmentInPlacementShares: "Investment In Placement Shares",
  ipoInvestment: "IPO Investment",
  ipdcFinanceLoan: "IPDC Finance Limited (Loan)",
  modhumotiBank: "Modhumoti Bank Limited",
  investmentEgf: "Investment in Mutual Fund(E.G.F)",
  investmentSrf: "Investment in Mutual Fund (S.R.F)",

  // Receivables / accruals (TB-C r16, r18, r19, r31–r33, r120)
  accruedInterestOnFdr: "Accrued Interest On FDR in Investment",
  managementFee: "Management Fee",
  aitReceivableAgainstMgmtFee: "AIT Receivable against Management Fee",
  dividendReceivable: "Dividend Receivable",
  managementFeeAccrued: "Management Fee Accrued",
  formationFeeReceivableEsrf: "Formation Fee Receivable from ESRF",
  receivableForClientHsbc: "Receivable for clint (HSBC)",
  commission: "Commission",

  // Equity (TB-C r20–r22)
  shareCapital: "Share Capital",
  retainedEarning: "Retained Earning",
  fairValueReserve: "Fair Value Reserve",

  // Liabilities — payables / accrued (TB-C r23, r38, r112–r115, r121, r122)
  auditFeeAccrued: "Audit Fee (accrued)",
  liabForEmployeeAllowance: "Liab For Employee Allowance",
  liabForPfFund: "Liab: For PF Fund",
  withholdingVatAndTds: "Withholding VAT & TDs",
  withholdingTaxEmployees: "Withholding TAX Employees",
  liabOfficeRent: "Liab-Office Rent",
  liabilityAuditFee: "Liability Audit Fee",
  liabUtilityExp: "Liab-Utility Exp.",

  // Tax (TB-C r26, r27, r87, r98, r104, r125)
  deferredTax: "Deferred Tax",
  provisionForIncomeTax: "Provision for income tax",
  advanceTaxDepositsPrepayments: "Advance Tax,Deposits and prepayments",
  sourceTax: "Source Tax",
  advanceToBsec: "Advance to BSEC",
  advanceIncomeTaxPayment: "Advance Income TAX Payment",

  // Income (TB-C r34, r35, r36, r100, r101, r102)
  interestIncomeOfFdr: "Interest Income of FDR",
  dividendIncome: "Dividend Income",
  advisoryFee: "Advisory Fee",
  interestIncome: "Interest Income",
  capitalGain: "Capital Gain",
  capitalLoss: "Capital Loss",

  // G&A expenses — TB-C r37–r42, r44–r73, r75–r80, r88–r96, r108, r118, r119, r124
  // (each row = one account; see workbook for full list)
  salaryAndAllowances: "Salary and Allowances",
  auditFee: "Audit Fee",
  agmExpense: "AGM Expense",
  brandingExpense: "Branding Expense",
  itExpense: "IT Expense",
  bsecApplicationFee: "BSEC Application Fee",
  internetBill: "Internet Bill",
  repairAndMaintenance: "Repair & Maintenance",
  licenseFee: "License fee",
  rent: "Rent",
  printingExpense: "Printing Expense",
  officeExpenses: "Office Expenses",
  websiteDevelopment: "Website development",
  depreciation: "Depreciation",
  entertainment: "Entertainment",
  stationary: "Stationary",
  miscellaneousExpenses: "Miscellaneous Expenses",
  conveyanceBill: "Conveyance bill",
  serviceCharge: "Service Charge",
  officeMaintenance: "Office Maintenance",
  utilityExpense: "Utility Expense",
  courierCharge: "Courier Charge",
  businessDevelopmentExpenses: "Business Development Expenses",
  advertisement: "Advertisement",
  dseExpense: "DSE Expense",
  payOrder: "Pay Order",
  boardMeetingExpenses: "Board Meeting Expenses",
  registrationLicenseRenewalFees: "Registration,License & Renewal Fees",
  rjscExpense: "RJSC Expense",
  wages: "Wages",
  booksAndPeriodicals: "Books & Periodicals",
  cdblCharge: "CDBL Charge",
  bankCharge: "Bank Charge",
  trainingFee: "Training Fee",
  exciseDuty: "Excise duty",
  exciseDutyOnFdr: "Excise duty on FDR",
  exciseDutyOnLoan: "Excise duty on Loan",
  dseCharge: "DSE charge",
  otherChargesOnLoan: "Other Charges on Loan",
  biddingFee: "Bidding Fee",
  subsidizationOfLoan: "Subsidization of loan",
  shortTermLoan: "Short Term Loan",
  fundTransfer: "Fund Transfer",
  egfSponser: "E.G.F Sponser",
  mobileBill: "Mobile bill",
  otherExp: "Other exp.",
  membershipExpenses: "Membership Expenses",
  operatingExp: "Operating Exp.",
  floodRelife: "FLOOD RELIFE",
  promostionExp: "Promostion exp.",
  professioalFee: "Professioal Fee",
  sellingAgentFees: "Selling agent fees",
  employeerContributionForPf: "Employeer Contribution For PF",
  regulatoryComplianceExpenses: "Regulatory Compliance Expenses",

  // Financial expenses (TB-C r74, r103)
  interestOnMarginLoan: "Interest on Margin  Loan",
  interestExpense: "Interest Expense",

  // Cash & equivalents (TB-C r81–r86, r106, r107, r110)
  bracBank1: "Brac (A/C No. 1513204232046001)",
  bracBank2: "Brac Bank (A/C No. 1513204232046002)",
  bkash: "Bkash (DM4952)",
  midland: "Midland (A/C No. 00011060000128)",
  modhumotiAccount: "Modhumoti (A/C No. 11351110000092)",
  pettyCash: "Petty Cash",
  abaciInvestmentC2505: "ABACI Investment(C2505)",
  abaciInvestment: "ABACI Investment",
  midlandBank: "Midland Bank",

  // Margin loan (TB-C r105, r123)
  ucbBo: "UCB BO (1205590068173895)",
  primeBankSecurities: "Prime Bank Securities Limited",

  // Security deposit (TB-C r116)
  securityDepositOfficeRent: "Security Deposit-Office Rent",
} as const;

/**
 * Account names used by financial-statement formulas (TB-C col G) that do
 * NOT exist in CHART_OF_ACCOUNTS_SEED with the same spelling. Resolve each
 * one (rename the CoA entry, or recognise it as a new account) before
 * importing journals — otherwise journal.account_name FK lookups will fail.
 */
export const WORKBOOK_NAME_DISCREPANCIES: ReadonlyArray<{
  tbCanonical: string;
  closestCoaMatch?: string;
  note: string;
}> = [
  { tbCanonical: "Office Equipment", closestCoaMatch: "Office Equipments", note: "singular vs plural" },
  { tbCanonical: "Salary and Allowances", closestCoaMatch: "Salary Expense", note: "renamed; same account" },
  { tbCanonical: "Wages", note: "missing from CoA" },
  { tbCanonical: "Membership Expenses", closestCoaMatch: "Membership Expense", note: "singular vs plural" },
  { tbCanonical: "Bkash (DM4952)", closestCoaMatch: "Bkash(DM4952)", note: "spacing" },
  { tbCanonical: "Capital Loss", closestCoaMatch: "Capital Gain/ loss", note: "split into Capital Gain + Capital Loss in TB-C" },
  { tbCanonical: "Interest Expense", note: "missing from CoA" },
  { tbCanonical: "Liab For Employee Allowance", note: "missing from CoA" },
  { tbCanonical: "Liab: For PF Fund", closestCoaMatch: "Liab. Employee Salary For PF", note: "renamed" },
  { tbCanonical: "Management Fee Accrued", note: "missing from CoA — likely a separate accrual sub-account" },
  { tbCanonical: "Training Fee", note: "missing from CoA" },
  { tbCanonical: "UCB BO (1205590068173895)", closestCoaMatch: "Margin Loan From UCB", note: "renamed to BO account number" },
  { tbCanonical: "IDLC Finance Limited (FDR)", closestCoaMatch: "IDLC Finance Limited", note: "TB-C added (FDR) qualifier" },
  { tbCanonical: "Investment In FDR (IPDC)", closestCoaMatch: "Investment In FDR", note: "TB-C added (IPDC) qualifier" },
  { tbCanonical: "Personal Loan to Shiful", closestCoaMatch: "Personal Loan to Saiful", note: "Shiful vs Saiful — typo on one side" },
];

// ─── Types ───────────────────────────────────────────────────────

export type StatementLine = {
  /** Display label as it should appear on the report. */
  label: string;
  /** Computed amount in BDT. Sign matches normal accounting presentation. */
  amount: number;
  /** Optional sub-grouping for the renderer. */
  group?: string;
};

export type IncomeStatement = {
  operatingIncome: StatementLine[];
  operatingExpenses: StatementLine[];
  financialExpenses: StatementLine[];
  profitBeforeTax: number;
  taxExpense: StatementLine[];
  profitForPeriod: number;
  oci: StatementLine[];
  totalComprehensiveIncome: number;
};

export type BalanceSheet = {
  nonCurrentAssets: StatementLine[];
  currentAssets: StatementLine[];
  totalAssets: number;
  equity: StatementLine[];
  nonCurrentLiabilities: StatementLine[];
  currentLiabilities: StatementLine[];
  totalEquityAndLiabilities: number;
};

// ─── Income Statement ────────────────────────────────────────────
// Spec §5.11 `get_income_statement`. Cell refs commented inline.

export function buildIncomeStatement(
  tb: TrialBalance,
  ext: ExternalInputs,
): IncomeStatement {
  // Management Fees = TB-C!L17
  const managementFees = netC(tb, ACCOUNT.managementFee);
  // Capital Gain = TB-C!I101 − TB-C!H102
  const capitalGain = grossC(tb, ACCOUNT.capitalGain) - grossD(tb, ACCOUNT.capitalLoss);
  // Interest Income = TB-C!I34 + TB-C!I100 − TB-C!H34
  const interestIncome =
    grossC(tb, ACCOUNT.interestIncomeOfFdr) +
    grossC(tb, ACCOUNT.interestIncome) -
    grossD(tb, ACCOUNT.interestIncomeOfFdr);
  // Advisory Fees = TB-C!L36
  const advisoryFees = netC(tb, ACCOUNT.advisoryFee);
  // Dividend Income = TB-C!L35
  const dividendIncome = netC(tb, ACCOUNT.dividendIncome);

  const operatingIncome: StatementLine[] = [
    { label: "Management Fees", amount: managementFees },
    { label: "Capital Gain", amount: capitalGain },
    { label: "Interest Income", amount: interestIncome },
    { label: "Advisory Fees", amount: advisoryFees },
    { label: "Dividend Income", amount: dividendIncome },
  ];
  const totalOperatingIncome = operatingIncome.reduce((s, l) => s + l.amount, 0);

  // General & Administrative Expenses
  // Spec: −SUM(K37:K42, K44:K73, K75:K80, K88:K96) − K108 − K118 − H119 + K71 + K73 − K124
  // Re-arranged to a positive expense magnitude:
  //   ΣK(rows 37–42, 44–73, 75–80, 88–96) + K108 + K118 + H119 − K71 − K73 + K124
  const gaSumAccounts: readonly string[] = [
    // r37–r42
    ACCOUNT.salaryAndAllowances, ACCOUNT.liabForEmployeeAllowance, ACCOUNT.auditFee,
    ACCOUNT.agmExpense, ACCOUNT.brandingExpense, ACCOUNT.itExpense,
    // r44–r73 (skip r43 'Software Purchase' — not in spec range)
    ACCOUNT.bsecApplicationFee, ACCOUNT.internetBill, ACCOUNT.repairAndMaintenance,
    ACCOUNT.licenseFee, ACCOUNT.rent, ACCOUNT.printingExpense, ACCOUNT.officeExpenses,
    ACCOUNT.websiteDevelopment, ACCOUNT.depreciation, ACCOUNT.entertainment,
    ACCOUNT.stationary, ACCOUNT.miscellaneousExpenses, ACCOUNT.conveyanceBill,
    ACCOUNT.serviceCharge, ACCOUNT.officeMaintenance, ACCOUNT.utilityExpense,
    ACCOUNT.courierCharge, ACCOUNT.businessDevelopmentExpenses, ACCOUNT.advertisement,
    ACCOUNT.dseExpense, ACCOUNT.payOrder, ACCOUNT.boardMeetingExpenses,
    ACCOUNT.registrationLicenseRenewalFees, ACCOUNT.rjscExpense, ACCOUNT.wages,
    ACCOUNT.booksAndPeriodicals, ACCOUNT.cdblCharge, ACCOUNT.bankCharge,
    ACCOUNT.trainingFee, ACCOUNT.exciseDuty,
    // r75–r80 (skip r74 'Interest on Margin Loan' — financial expense)
    ACCOUNT.exciseDutyOnFdr, ACCOUNT.exciseDutyOnLoan, ACCOUNT.dseCharge,
    ACCOUNT.otherChargesOnLoan, ACCOUNT.biddingFee, ACCOUNT.subsidizationOfLoan,
    // r88–r96 (skip r87 'Advance Tax,Deposits and prepayments' — current asset)
    ACCOUNT.shortTermLoan, ACCOUNT.fundTransfer, ACCOUNT.egfSponser, ACCOUNT.mobileBill,
    ACCOUNT.otherExp, ACCOUNT.membershipExpenses, ACCOUNT.operatingExp,
    ACCOUNT.floodRelife, ACCOUNT.promostionExp,
  ];
  const ga =
    sumNetD(tb, gaSumAccounts)
    + netD(tb, ACCOUNT.professioalFee)                    // K108
    + netD(tb, ACCOUNT.sellingAgentFees)                  // K118
    + grossD(tb, ACCOUNT.employeerContributionForPf)      // H119 (gross debit)
    - netD(tb, ACCOUNT.bankCharge)                        // K71 — moved to financial
    - netD(tb, ACCOUNT.exciseDuty)                        // K73 — moved to financial
    + netD(tb, ACCOUNT.regulatoryComplianceExpenses);     // K124

  // Financial Expenses
  // Spec: −(H74 + H103 − I103) + L88 − K71 − K73
  // Positive magnitude: (H74 + H103 − I103) − L88 + K71 + K73
  const financialExpenseMagnitude =
    grossD(tb, ACCOUNT.interestOnMarginLoan)              // H74
    + grossD(tb, ACCOUNT.interestExpense)                 // H103
    - grossC(tb, ACCOUNT.interestExpense)                 // I103
    - netC(tb, ACCOUNT.shortTermLoan)                     // L88
    + netD(tb, ACCOUNT.bankCharge)                        // K71
    + netD(tb, ACCOUNT.exciseDuty);                       // K73

  const operatingExpenses: StatementLine[] = [
    { label: "General & Administrative Expenses", amount: ga },
  ];
  const financialExpenses: StatementLine[] = [
    { label: "Financial Expenses", amount: financialExpenseMagnitude },
  ];

  const profitBeforeTax = totalOperatingIncome - ga - financialExpenseMagnitude;

  // Income Tax Expense — uses Notes.(2)!F12 current-tax provision.
  const taxExpense: StatementLine[] = [
    { label: "Current Tax Expense", amount: ext.currentTaxProvision },
  ];

  const profitForPeriod = profitBeforeTax - ext.currentTaxProvision;

  // OCI
  // Unrealised loss on listed shares = −Annexure march!K27 (negative because it's a loss)
  const ociUnrealisedLoss = -ext.unrealisedFairValueLoss;
  // Deferred tax effect = −OCI × 15%  (positive when OCI is a loss → reduces tax liability)
  const deferredTax = -ociUnrealisedLoss * 0.15;
  const oci: StatementLine[] = [
    { label: "Unrealised Loss on Investment in Stocks", amount: ociUnrealisedLoss },
    { label: "Deferred Tax Expense", amount: deferredTax },
  ];
  const totalComprehensiveIncome = profitForPeriod + ociUnrealisedLoss + deferredTax;

  return {
    operatingIncome,
    operatingExpenses,
    financialExpenses,
    profitBeforeTax,
    taxExpense,
    profitForPeriod,
    oci,
    totalComprehensiveIncome,
  };
}

// ─── Balance Sheet ───────────────────────────────────────────────
// Spec §5.11 `get_balance_sheet`. Cell refs commented inline.

export function buildBalanceSheet(
  tb: TrialBalance,
  ext: ExternalInputs,
): BalanceSheet {
  // Property, Plant & Equipment = TB-C!K7 + K8 + K9
  const ppe =
    netD(tb, ACCOUNT.computers)
    + netD(tb, ACCOUNT.officeDecoration)
    + netD(tb, ACCOUNT.officeEquipment);

  // Security Deposit-Office Rent = TB-C!K116 (or 200,000 fallback per spec)
  const securityDeposit = netD(tb, ACCOUNT.securityDepositOfficeRent);

  // Investment in Securities = K10 + K11 + K13 + K29 + K30 + K12
  const investmentInSecurities =
    netD(tb, ACCOUNT.investmentEfuf)              // K10
    + netD(tb, ACCOUNT.investmentInShare)         // K11
    + netD(tb, ACCOUNT.ipoInvestment)             // K13
    + netD(tb, ACCOUNT.investmentEgf)             // K29
    + netD(tb, ACCOUNT.investmentSrf)             // K30
    + netD(tb, ACCOUNT.investmentInPlacementShares); // K12

  // Sundry Receivables = K16 + K19 + K31 + K32 + K33 + K120 + Annexure!M131
  const sundryReceivables =
    netD(tb, ACCOUNT.accruedInterestOnFdr)        // K16
    + netD(tb, ACCOUNT.dividendReceivable)        // K19
    + netD(tb, ACCOUNT.managementFeeAccrued)      // K31
    + netD(tb, ACCOUNT.formationFeeReceivableEsrf) // K32
    + netD(tb, ACCOUNT.receivableForClientHsbc)   // K33
    + netD(tb, ACCOUNT.commission)                // K120
    + ext.fairValueReceivableAdjustment;          // Annexure!M131

  // AIT Receivables against Mgmt Fee = K18
  const aitReceivablesMgmtFee = netD(tb, ACCOUNT.aitReceivableAgainstMgmtFee);

  // Cash and Cash Equivalents = K81 + K82 + K84 + K85 + K86 + K83 + K106 + K110 + K107
  const cashAndEquivalents =
    netD(tb, ACCOUNT.bracBank1)                   // K81
    + netD(tb, ACCOUNT.bracBank2)                 // K82
    + netD(tb, ACCOUNT.midland)                   // K84
    + netD(tb, ACCOUNT.modhumotiAccount)          // K85
    + netD(tb, ACCOUNT.pettyCash)                 // K86
    + netD(tb, ACCOUNT.bkash)                     // K83
    + netD(tb, ACCOUNT.abaciInvestmentC2505)      // K106
    + netD(tb, ACCOUNT.midlandBank)               // K110
    + netD(tb, ACCOUNT.abaciInvestment);          // K107

  // Advance, Deposit and Pre-payment = K87 + K98 + K125 + K104
  const advanceDepositPrepayment =
    netD(tb, ACCOUNT.advanceTaxDepositsPrepayments) // K87
    + netD(tb, ACCOUNT.sourceTax)                   // K98
    + netD(tb, ACCOUNT.advanceIncomeTaxPayment)     // K125
    + netD(tb, ACCOUNT.advanceToBsec);              // K104

  // Margin Loan to UCB = −(K105 + K123). UCB BO row 105 is a NEGATIVE
  // debit (it's a liability), so the unary minus flips it positive.
  // Prime Bank Securities (r123) gets the same treatment.
  const marginLoanToUcb = -(netD(tb, ACCOUNT.ucbBo) + netD(tb, ACCOUNT.primeBankSecurities));

  const nonCurrentAssets: StatementLine[] = [
    { label: "Property, Plant & Equipment", amount: ppe },
    { label: "Security Deposit-Office Rent", amount: securityDeposit },
    { label: "Investment in Securities", amount: investmentInSecurities },
  ];
  const currentAssets: StatementLine[] = [
    { label: "Sundry Receivables", amount: sundryReceivables },
    { label: "AIT Receivables against Mgmt Fee", amount: aitReceivablesMgmtFee },
    { label: "Cash and Cash Equivalents", amount: cashAndEquivalents },
    { label: "Advance, Deposit and Pre-payment", amount: advanceDepositPrepayment },
  ];
  // Margin loan only appears on the liability side (see nonCurrentLiabilities
  // below). Spec §5.11 lists it as a single line; the contra-asset rendering
  // in an earlier draft double-counted it.
  const totalAssets =
    nonCurrentAssets.reduce((s, l) => s + l.amount, 0)
    + currentAssets.reduce((s, l) => s + l.amount, 0);

  // Equity
  const equity: StatementLine[] = [
    // Share Capital = L20
    { label: "Share Capital", amount: netC(tb, ACCOUNT.shareCapital) },
    // Retained Earnings = L21 + IS!H25 (current-year profit)
    { label: "Retained Earnings", amount: netC(tb, ACCOUNT.retainedEarning) + ext.currentPeriodNetProfit },
    // Fair Value Reserve = L22
    { label: "Fair Value Reserve", amount: netC(tb, ACCOUNT.fairValueReserve) },
  ];

  // Non-current liabilities
  const nonCurrentLiabilities: StatementLine[] = [
    // Deferred Tax Liability = L26
    { label: "Deferred Tax Liability", amount: netC(tb, ACCOUNT.deferredTax) },
    // Margin Loan as a liability line
    { label: "Margin Loan to UCB", amount: marginLoanToUcb },
  ];

  // Current liabilities
  // Spec formula: L27 − IS!H24. Workbook stores IS!H24 as NEGATIVE (tax is a
  // reduction of profit), so −(negative) = +. We store currentPeriodTaxExpense
  // as a positive magnitude, so we add directly.
  const provisionForIncomeTax =
    netC(tb, ACCOUNT.provisionForIncomeTax) + ext.currentPeriodTaxExpense;

  const liabilityForOtherExpenses =
    netC(tb, ACCOUNT.auditFeeAccrued)            // L23
    + netC(tb, ACCOUNT.liabForEmployeeAllowance) // L38
    + netC(tb, ACCOUNT.liabOfficeRent)           // L115
    + netC(tb, ACCOUNT.liabilityAuditFee)        // L121
    + netC(tb, ACCOUNT.liabUtilityExp);          // L122

  const liabForProvidentFund = grossC(tb, ACCOUNT.liabForPfFund); // I112 (gross credit)
  const withholdingVatAndTds =
    netC(tb, ACCOUNT.withholdingVatAndTds)       // L113
    + netC(tb, ACCOUNT.withholdingTaxEmployees); // L114

  const currentLiabilities: StatementLine[] = [
    { label: "Provision for Income Tax", amount: provisionForIncomeTax },
    { label: "Liability for Other Expenses", amount: liabilityForOtherExpenses },
    { label: "Liab. For Provident Fund", amount: liabForProvidentFund },
    { label: "Withholding VAT & TDs", amount: withholdingVatAndTds },
  ];

  const totalEquityAndLiabilities =
    equity.reduce((s, l) => s + l.amount, 0)
    + nonCurrentLiabilities.reduce((s, l) => s + l.amount, 0)
    + currentLiabilities.reduce((s, l) => s + l.amount, 0);

  return {
    nonCurrentAssets,
    currentAssets,
    totalAssets,
    equity,
    nonCurrentLiabilities,
    currentLiabilities,
    totalEquityAndLiabilities,
  };
}

// ─── Statement of Changes in Equity ──────────────────────────────
// Spec §5.11 CE sheet — columns: Paid-up Capital, Fair Value Reserve,
// Retained Earnings, Total. Rows: opening, dividend paid, share issue,
// comprehensive income, prior-year adjustment, OCI, closing.
//
// All inputs derive from data the system already has:
//   - opening balances per equity account → from AccountOpeningBalance
//   - profit for the period → from IS (drives RE)
//   - OCI total → from IS (drives FVR)
//   - dividend paid / share issue → from journal activity against the
//     equity accounts during the period (gross debit/credit minus the
//     IS-driven movements)
//   - prior-year adjustment to RE → any RE TB movement not explained by
//     the current-period profit

export type ChangesInEquityRow = {
  label: string;
  paidUpCapital: number;
  fairValueReserve: number;
  retainedEarnings: number;
  total: number;
  /** Bold + top-rule rendering for opening/closing balances. */
  subtotal?: boolean;
};

export type ChangesInEquityPeriod = {
  /** Display label for the opening date — workbook says "Balance as at <date>". */
  openingDate: Date;
  /** Display label for the closing date. */
  closingDate: Date;
  rows: ChangesInEquityRow[];
  /** Closing equity per the rollforward; reconcile against BS equity total. */
  closingTotal: number;
};

export type ChangesInEquity = {
  current: ChangesInEquityPeriod;
  /** Inputs the caller couldn't supply (e.g. opening balances missing). */
  needsInputs: string[];
};

/** Minimal shape of an opening-balance row. Defined here so this module
 * stays free of Prisma types — callers pass plain data. */
export type EquityOpeningBalances = {
  shareCapital: number | undefined;
  fairValueReserve: number | undefined;
  retainedEarning: number | undefined;
};

export function buildChangesInEquity(
  tb: TrialBalance,
  is1: IncomeStatement,
  opening: EquityOpeningBalances,
  fiscalYear: { startsOn: Date; endsOn: Date },
): ChangesInEquity {
  const needsInputs: string[] = [];

  // Opening balances — fall back to TB net credit when no opening_balances
  // row was recorded (zero-history case during initial migration).
  let openingSc = opening.shareCapital;
  if (openingSc === undefined) {
    openingSc = netC(tb, ACCOUNT.shareCapital);
    needsInputs.push("Opening balance row for 'Share Capital' in `account_opening_balances`");
  }
  let openingFvr = opening.fairValueReserve;
  if (openingFvr === undefined) {
    openingFvr = netC(tb, ACCOUNT.fairValueReserve);
    needsInputs.push("Opening balance row for 'Fair Value Reserve' in `account_opening_balances`");
  }
  let openingRe = opening.retainedEarning;
  if (openingRe === undefined) {
    openingRe = netC(tb, ACCOUNT.retainedEarning);
    needsInputs.push("Opening balance row for 'Retained Earning' in `account_opening_balances`");
  }

  // Journal activity on the equity accounts during the period. Share issue =
  // gross credit on Share Capital. Dividend declared = gross debit on
  // Retained Earnings minus current-period close transfer (which our system
  // does NOT post — profit is held in the IS and flows to RE at year-end).
  const shareIssue = grossC(tb, ACCOUNT.shareCapital);
  const dividendPaid = grossD(tb, ACCOUNT.retainedEarning);

  // Profit for the period → Retained Earnings.
  const profit = is1.profitForPeriod;

  // OCI total → Fair Value Reserve.
  const ociTotal = is1.oci.reduce((s, l) => s + l.amount, 0);

  // Prior-year adjustment = anything in TB's RE balance not explained by
  // opening + period activity. Captures opening-balance corrections etc.
  const reTbBalance = netC(tb, ACCOUNT.retainedEarning);
  const priorYearAdjustment = reTbBalance - openingRe + dividendPaid;

  // Build the rows. Workbook order: Opening, Dividend Paid, Share Issue,
  // Comprehensive Income, Prior-Year Adjustment, OCI, Closing.
  const openingRow: ChangesInEquityRow = {
    label: `Balance as at ${formatDate(addDays(fiscalYear.startsOn, -1))}`,
    paidUpCapital: openingSc,
    fairValueReserve: openingFvr,
    retainedEarnings: openingRe,
    total: openingSc + openingFvr + openingRe,
    subtotal: true,
  };

  const activityRows: ChangesInEquityRow[] = [
    row("Dividend Paid", 0, 0, -dividendPaid),
    row("Share Issue During the Period", shareIssue, 0, 0),
    row("Comprehensive Income/Loss During the Year", 0, 0, profit),
    row("Prior Year Adjustment", 0, 0, priorYearAdjustment),
    row("Other Comprehensive Income/Loss", 0, ociTotal, 0),
  ];

  const closingSc = openingSc + shareIssue;
  const closingFvr = openingFvr + ociTotal;
  const closingRe = openingRe - dividendPaid + profit + priorYearAdjustment;
  const closingTotal = closingSc + closingFvr + closingRe;
  const closingRow: ChangesInEquityRow = {
    label: `Balance as at ${formatDate(fiscalYear.endsOn)}`,
    paidUpCapital: closingSc,
    fairValueReserve: closingFvr,
    retainedEarnings: closingRe,
    total: closingTotal,
    subtotal: true,
  };

  return {
    current: {
      openingDate: addDays(fiscalYear.startsOn, -1),
      closingDate: fiscalYear.endsOn,
      rows: [openingRow, ...activityRows, closingRow],
      closingTotal,
    },
    needsInputs,
  };
}

function row(
  label: string,
  paidUpCapital: number,
  fairValueReserve: number,
  retainedEarnings: number,
): ChangesInEquityRow {
  return {
    label,
    paidUpCapital,
    fairValueReserve,
    retainedEarnings,
    total: paidUpCapital + fairValueReserve + retainedEarnings,
  };
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

function formatDate(d: Date): string {
  const month = d.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
  return `${month} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}
