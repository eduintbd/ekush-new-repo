/* eslint-disable */
// IS-coverage diagnostic. Walks the trial balance for the active FY
// and reports which accounts are mapped to an Income Statement line,
// which are mapped to a Balance Sheet line, and which fall through
// to nothing. The "fall through" set is where the IS profit gap
// usually lives — manual JV entries to income/expense accounts that
// aren't named in the IS mapping silently disappear.
//
// Also prints the reconstructed P&L per the live mapping so the user
// can see which line items roll up where.
//
// Run: npx tsx scripts/diag-is-coverage.ts

import { config } from "dotenv";
config({ path: ".env" });

import { PrismaClient } from "@/generated/prisma";
import { getTrialBalance } from "@/lib/trial-balance";
import { getStatements } from "@/lib/statements";

const prisma = new PrismaClient();

// Account names referenced by the IS mapping. Keep in sync with
// statement_mapping.ts:buildIncomeStatement.
const IS_NAMES = new Set<string>([
  // Operating income
  "Interest Income of FDR", "Dividend Income", "Advisory Fee",
  "Interest Income", "Capital Gain", "Capital Loss", "Management Fee",
  "Realised Gain/(Loss) on Investments", "Unrealised Gain/(Loss) on Investments",
  // G&A expenses
  "Salary and Allowances", "Audit Fee", "AGM Expense", "Branding Expense",
  "IT Expense", "BSEC Application Fee", "Internet Bill", "Repair & Maintenance",
  "License fee", "Rent", "Printing Expense", "Office Expenses",
  "Website development", "Depreciation", "Entertainment", "Stationary",
  "Miscellaneous Expenses", "Conveyance bill", "Service Charge",
  "Office Maintenance", "Utility Expense", "Courier Charge",
  "Business Development Expenses", "Advertisement", "DSE Expense",
  "Pay Order", "Board Meeting Expenses", "Registration,License & Renewal Fees",
  "RJSC Expense", "Wages", "Books & Periodicals", "CDBL Charge", "Bank Charge",
  "Training Fee", "Excise duty", "Excise duty on FDR", "Excise duty on Loan",
  "DSE charge", "Other Charges on Loan", "Bidding Fee", "Subsidization of loan",
  "Short Term Loan", "Fund Transfer", "E.G.F Sponser", "Mobile bill",
  "Other exp.", "Membership Expense", "Operating Exp.", "FLOOD RELIFE",
  "Promostion exp.", "Professioal Fee", "Selling agent fees",
  "Employeer Contribution For PF", "Regulatory Compliance Expenses",
  // Financial
  "Interest on Margin  Loan", "Interest Expense",
]);

const BS_NAMES = new Set<string>([
  // PPE
  "Computers", "Office Decoration", "Office Equipments",
  // Security deposit
  "Security Deposit-Office Rent",
  // Investments
  "Investment in Mutual Fund(E.F.U.F)", "Investment in share",
  "Investment In Placement Shares", "IPO Investment",
  "Investment in Mutual Fund(E.G.F)", "Investment in Mutual Fund (S.R.F)",
  // Receivables
  "Accrued Interest On FDR in Investment", "Dividend Receivable",
  "Management Fee Accrued", "Formation Fee Receivable from ESRF",
  "Receivable for clint (HSBC)", "Commission",
  "AIT Receivables against Management Fee",
  // Cash
  "Brac (A/C No. 1513204232046001)", "Brac Bank (A/C No. 1513204232046002)",
  "Midland (A/C No. 00011060000128)", "Modhumoti (A/C No. 11351110000092)",
  "Petty Cash", "Bkash(DM4952)", "ABACI Investment(C2505)",
  "ABACI Investment", "Midland Bank",
  // Advances
  "Advance Tax,Deposits and prepayments", "Source Tax",
  "Advance Income TAX Payment", "Advance to BSEC",
  // Equity + liab
  "Share Capital", "Retained Earning", "Fair Value Reserve",
  "Deferred Tax", "Provision for income tax",
  "Audit Fee (accrued)", "Liab For Employee Allowance",
  "Liab-Office Rent", "Liability Audit Fee", "Liab-Utility Exp.",
  "Liab. Employee Salary For PF", "Withholding VAT & TDs", "Withholding TAX Employees",
  // Margin loan (new)
  "Margin Loan From UCB", "Margin Loan From Prime Bank Securities",
  "UCB BO (1205590068173895)", "Prime Bank Securities Limited",
]);

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}
function padR(s: string, n: number): string {
  return s.length >= n ? s : " ".repeat(n - s.length) + s;
}
function bdt(n: number): string {
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function main() {
  const fy = await prisma.fiscalYear.findFirst({
    orderBy: { startsOn: "desc" },
    select: { id: true, label: true },
  });
  if (!fy) throw new Error("No fiscal year");
  console.log(`Fiscal year: ${fy.label}\n`);

  const tb = await getTrialBalance(fy.id);
  const active = tb.rows.filter((r) => r.netDebit > 0.005 || r.netCredit > 0.005);

  const unmapped: typeof active = [];
  const isMapped: typeof active = [];
  const bsMapped: typeof active = [];

  for (const r of active) {
    if (IS_NAMES.has(r.accountName)) isMapped.push(r);
    else if (BS_NAMES.has(r.accountName)) bsMapped.push(r);
    else unmapped.push(r);
  }

  // Sort by absolute balance, descending.
  unmapped.sort((a, b) => Math.abs(b.netDebit - b.netCredit) - Math.abs(a.netDebit - a.netCredit));

  console.log(`=== UNMAPPED TB accounts with activity (${unmapped.length}) ===`);
  console.log(`(neither in IS_NAMES nor BS_NAMES — these slip out of all financial statements)`);
  console.log("");
  if (unmapped.length === 0) {
    console.log("  (none — every active account is mapped)");
  } else {
    console.log(`${pad("Account", 50)} ${pad("Norm", 6)} ${padR("Net Debit", 16)} ${padR("Net Credit", 16)} ${padR("Net Bal", 16)}`);
    console.log("─".repeat(108));
    for (const r of unmapped) {
      const bal = r.netDebit - r.netCredit;
      console.log(
        `${pad(r.accountName, 50)} ${pad(r.normalBalance, 6)} ${padR(bdt(r.netDebit), 16)} ${padR(bdt(r.netCredit), 16)} ${padR(bdt(bal), 16)}`,
      );
    }
  }

  // IS-side accounts with activity, by direction.
  const isCredits = isMapped.filter((r) => r.netCredit > r.netDebit);
  const isDebits = isMapped.filter((r) => r.netDebit >= r.netCredit);
  const totalIncome = isCredits.reduce((s, r) => s + (r.netCredit - r.netDebit), 0);
  const totalExpense = isDebits.reduce((s, r) => s + (r.netDebit - r.netCredit), 0);

  console.log("");
  console.log("=== IS-side income (net Cr) ===");
  for (const r of isCredits.sort((a, b) => (b.netCredit - b.netDebit) - (a.netCredit - a.netDebit))) {
    console.log(`  ${pad(r.accountName, 50)} ${padR(bdt(r.netCredit - r.netDebit), 16)}`);
  }
  console.log(`  ${pad("─── Σ Income", 50)} ${padR(bdt(totalIncome), 16)}`);

  console.log("");
  console.log("=== IS-side expenses (net Dr) ===");
  for (const r of isDebits.sort((a, b) => (b.netDebit - b.netCredit) - (a.netDebit - a.netCredit))) {
    console.log(`  ${pad(r.accountName, 50)} ${padR(bdt(r.netDebit - r.netCredit), 16)}`);
  }
  console.log(`  ${pad("─── Σ Expense", 50)} ${padR(bdt(totalExpense), 16)}`);

  // Reconstructed P&L per live mapping vs computed via getStatements
  console.log("");
  console.log("=== P&L summary ===");
  console.log(`  Σ Income (mapped IS-cr accounts)      ${bdt(totalIncome)}`);
  console.log(`  Σ Expense (mapped IS-dr accounts)     ${bdt(totalExpense)}`);
  console.log(`  Σ Income − Σ Expense                  ${bdt(totalIncome - totalExpense)}`);

  const stmts = await getStatements(fy.id);
  console.log("");
  console.log(`  IS.profitBeforeTax  (from getStatements)   ${bdt(stmts.incomeStatement.profitBeforeTax)}`);
  console.log(`  IS.profitForPeriod  (from getStatements)   ${bdt(stmts.incomeStatement.profitForPeriod)}`);
  console.log(`  Workbook expected   period profit          77,16,913.00`);
  console.log(`  Gap                                        ${bdt(77_16_913 - stmts.incomeStatement.profitForPeriod)}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
