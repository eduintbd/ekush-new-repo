/* eslint-disable */
// Diagnostic for /balance-sheet "✗ Out of balance" pill.
// Run: npx tsx scripts/diag-bs-imbalance.ts [--fy=<fiscalYearId>]
//
// Walks the trial balance for the selected fiscal year and cross-references
// every account with non-zero activity against the hand-curated BS / IS
// mapping in statement_mapping.ts. Surfaces:
//   - TB accounts not consumed by ANY statement line (silently dropped)
//   - mapping names that have no TB activity (look up to nowhere)
//   - the Margin Loan triad (sl 99, 130, 131) which the BS reads wrong
//   - a predicted post-fix BS diff
//
// Read-only. No writes.

import { config } from "dotenv";
config({ path: ".env" });

import { PrismaClient } from "@/generated/prisma";
import { getTrialBalance } from "@/lib/trial-balance";
import { getStatements } from "@/lib/statements";

const prisma = new PrismaClient();

// Account name → BS line label. Mirrors statement_mapping.ts:buildBalanceSheet.
// Source of truth is the ACCOUNT constant + the line builders; this is a
// snapshot for diagnostic purposes only.
const BS_MAPPING: Record<string, string> = {
  // Non-Current Assets
  "Computers": "Property, Plant & Equipment",
  "Office Decoration": "Property, Plant & Equipment",
  "Office Equipment": "Property, Plant & Equipment",
  "Security Deposit-Office Rent": "Security Deposit-Office Rent",
  "Investment in Mutual Fund(E.F.U.F)": "Investment in Securities",
  "Investment in share": "Investment in Securities",
  "Investment In Placement Shares": "Investment in Securities",
  "IPO Investment": "Investment in Securities",
  "Investment in Mutual Fund(E.G.F)": "Investment in Securities",
  "Investment in Mutual Fund (S.R.F)": "Investment in Securities",
  // Current Assets — Sundry Receivables
  "Accrued Interest On FDR in Investment": "Sundry Receivables",
  "Dividend Receivable": "Sundry Receivables",
  "Management Fee Accrued": "Sundry Receivables",
  "Formation Fee Receivable from ESRF": "Sundry Receivables",
  "Receivable for clint (HSBC)": "Sundry Receivables",
  "Commission": "Sundry Receivables",
  // Current Assets — AIT
  "AIT Receivable against Management Fee": "AIT Receivables against Mgmt Fee",
  // Current Assets — Cash
  "Brac (A/C No. 1513204232046001)": "Cash and Cash Equivalents",
  "Brac Bank (A/C No. 1513204232046002)": "Cash and Cash Equivalents",
  "Midland (A/C No. 00011060000128)": "Cash and Cash Equivalents",
  "Modhumoti (A/C No. 11351110000092)": "Cash and Cash Equivalents",
  "Petty Cash": "Cash and Cash Equivalents",
  "Bkash(DM4952)": "Cash and Cash Equivalents",
  "ABACI Investment(C2505)": "Cash and Cash Equivalents",
  "ABACI Investment": "Cash and Cash Equivalents",
  "Midland Bank": "Cash and Cash Equivalents",
  // Current Assets — Advances
  "Advance Tax,Deposits and prepayments": "Advance, Deposit and Pre-payment",
  "Source Tax": "Advance, Deposit and Pre-payment",
  "Advance Income TAX Payment": "Advance, Deposit and Pre-payment",
  "Advance to BSEC": "Advance, Deposit and Pre-payment",
  // Equity
  "Share Capital": "Share Capital",
  "Retained Earning": "Retained Earnings",
  "Fair Value Reserve": "Fair Value Reserve",
  // Non-current Liabilities
  "Deferred Tax": "Deferred Tax Liability",
  // Current Liabilities — Margin Loan triad. Both the broker BO accounts
  // (asset-typed, credit-balanced when overdrawn) and the dedicated
  // "Margin Loan From..." liability accounts flow into the same BS line.
  "UCB BO (1205590068173895)": "Margin Loan to Stock Brokers",
  "Prime Bank Securities Limited": "Margin Loan to Stock Brokers",
  "Margin Loan From UCB": "Margin Loan to Stock Brokers",
  "Margin Loan From Prime Bank Securities": "Margin Loan to Stock Brokers",
  // Current Liabilities
  "Provision for income tax": "Provision for Income Tax",
  "Audit Fee (accrued)": "Liability for Other Expenses",
  "Liab For Employee Allowance": "Liability for Other Expenses",
  "Liab-Office Rent": "Liability for Other Expenses",
  "Liability Audit Fee": "Liability for Other Expenses",
  "Liab-Utility Exp.": "Liability for Other Expenses",
  "Liab: For PF Fund": "Liab. For Provident Fund",
  "Withholding VAT & TDs": "Withholding VAT & TDs",
  "Withholding TAX Employees": "Withholding VAT & TDs",
};

// Account names that flow into the Income Statement (any line). Used to
// decide whether a TB account is "unmapped on BS" or "P&L (handled via RE
// plug)". Keep in sync with statement_mapping.ts:buildIncomeStatement.
const IS_NAMES = new Set<string>([
  // Income
  "Interest Income of FDR", "Dividend Income", "Advisory Fee",
  "Interest Income", "Capital Gain", "Capital Loss",
  "Realised Gain/(Loss) on Investments", "Unrealised Gain/(Loss) on Investments",
  "Management Fee",
  // Expenses (G&A)
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
  // Financial expenses
  "Interest on Margin  Loan", "Interest Expense",
]);

type Row = {
  sl: number;
  accountName: string;
  normalBalance: "DEBIT" | "CREDIT";
  netDebit: number;
  netCredit: number;
};

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function padR(s: string, n: number): string {
  return s.length >= n ? s : " ".repeat(n - s.length) + s;
}

function bdt(n: number): string {
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function pickLatestFy(): Promise<string> {
  const fy = await prisma.fiscalYear.findFirst({
    orderBy: { startsOn: "desc" },
    select: { id: true, label: true },
  });
  if (!fy) throw new Error("No fiscal years in DB");
  console.log(`No --fy passed — using latest: ${fy.label} (${fy.id})\n`);
  return fy.id;
}

async function main() {
  const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
      const [k, v] = a.replace(/^--/, "").split("=");
      return [k, v ?? "true"];
    }),
  );

  const fyId = (args.fy as string | undefined) ?? (await pickLatestFy());

  const tbReport = await getTrialBalance(fyId);
  console.log(`Fiscal year: ${tbReport.fiscalYearLabel}`);
  console.log(`Window: ${tbReport.startsOn.toISOString().slice(0, 10)} → ${tbReport.endsOn.toISOString().slice(0, 10)}`);
  console.log(
    `TB ${tbReport.isBalanced ? "✓ balanced" : "✗ unbalanced"} — Σ netDebit ${bdt(tbReport.totals.netDebit)}, Σ netCredit ${bdt(tbReport.totals.netCredit)}, Δ ${bdt(tbReport.totals.netDebit - tbReport.totals.netCredit)}`,
  );

  // Recompute BS exactly as the page does.
  const statements = await getStatements(fyId);
  const { balanceSheet } = statements;
  const diff = balanceSheet.totalAssets - balanceSheet.totalEquityAndLiabilities;
  console.log("");
  console.log(`BS recomputed:`);
  console.log(`  Total Assets               ${padR(bdt(balanceSheet.totalAssets), 18)}`);
  console.log(`  Total Equity & Liabilities ${padR(bdt(balanceSheet.totalEquityAndLiabilities), 18)}`);
  console.log(`  Diff (TA − TEL)            ${padR(bdt(diff), 18)}  ${Math.abs(diff) < 1 ? "✓ balanced" : "✗ OUT OF BALANCE"}`);

  // Walk TB; classify each account.
  const activeRows: Row[] = tbReport.rows
    .filter((r) => Math.abs(r.netDebit) > 0.005 || Math.abs(r.netCredit) > 0.005)
    .map((r) => ({
      sl: r.sl,
      accountName: r.accountName,
      normalBalance: r.normalBalance,
      netDebit: r.netDebit,
      netCredit: r.netCredit,
    }));

  const unmapped: Row[] = [];
  for (const r of activeRows) {
    if (BS_MAPPING[r.accountName]) continue;
    if (IS_NAMES.has(r.accountName)) continue;
    unmapped.push(r);
  }

  // Sort by absolute net balance, descending.
  unmapped.sort((a, b) => Math.abs(b.netDebit - b.netCredit) - Math.abs(a.netDebit - a.netCredit));

  console.log("");
  console.log("=== UNMAPPED TB accounts with activity (top suspects) ===");
  console.log(`(present in TB, not consumed by any BS or IS line — silently dropped from financial statements)`);
  console.log("");
  console.log(`${pad("Account", 50)} ${pad("Norm", 6)} ${padR("Net Debit", 16)} ${padR("Net Credit", 16)} ${padR("Net Balance", 16)}`);
  console.log("─".repeat(108));
  if (unmapped.length === 0) {
    console.log("  (none — every active account is mapped somewhere)");
  } else {
    for (const r of unmapped.slice(0, 25)) {
      const bal = r.netDebit - r.netCredit;
      console.log(
        `${pad(r.accountName, 50)} ${pad(r.normalBalance, 6)} ${padR(bdt(r.netDebit), 16)} ${padR(bdt(r.netCredit), 16)} ${padR(bdt(bal), 16)}`,
      );
    }
    if (unmapped.length > 25) console.log(`  … ${unmapped.length - 25} more, all with |bal| ≤ ${bdt(Math.abs(unmapped[24].netDebit - unmapped[24].netCredit))}`);
  }

  // Decompose unmapped impact on BS by normal balance.
  let assetSideMissing = 0; // debit-normal unmapped accounts → would have increased TA
  let liabEquitySideMissing = 0; // credit-normal unmapped accounts → would have increased TEL
  for (const r of unmapped) {
    if (r.normalBalance === "DEBIT") {
      assetSideMissing += r.netDebit - r.netCredit;
    } else {
      liabEquitySideMissing += r.netCredit - r.netDebit;
    }
  }
  console.log("");
  console.log(`Asset-side unmapped (would lift TA):           ${bdt(assetSideMissing)}`);
  console.log(`Liab/equity-side unmapped (would lift TEL):    ${bdt(liabEquitySideMissing)}`);
  const predictedDiff = diff - assetSideMissing + liabEquitySideMissing;
  console.log(`Predicted diff if every unmapped row mapped:   ${bdt(predictedDiff)}`);

  // Specifically check the Margin Loan triad.
  console.log("");
  console.log("=== Margin Loan triad ===");
  const triad = [
    "Margin Loan From UCB", // sl 99, CREDIT
    "UCB BO (1205590068173895)", // sl 130, DEBIT — what BS currently reads
    "Margin Loan From Prime Bank Securities", // sl 131, CREDIT
    "Prime Bank Securities Limited", // sl 125, DEBIT — what BS also reads
  ];
  for (const name of triad) {
    const r = tbReport.rows.find((x) => x.accountName === name);
    if (!r) {
      console.log(`  ${pad(name, 45)} (not in seed / no row)`);
      continue;
    }
    const mappedTo = BS_MAPPING[name] ?? (IS_NAMES.has(name) ? "(IS)" : "← UNMAPPED");
    console.log(
      `  ${pad(name, 45)} ${pad(r.normalBalance, 6)} Dr ${padR(bdt(r.netDebit), 14)} Cr ${padR(bdt(r.netCredit), 14)}  → ${mappedTo}`,
    );
  }

  // Mapping → TB lookups that miss.
  const tbNameSet = new Set(activeRows.map((r) => r.accountName));
  const missingNames = Object.keys(BS_MAPPING).filter((n) => !tbNameSet.has(n));
  console.log("");
  console.log("=== BS_MAPPING names with NO TB activity ===");
  console.log(`(the BS line tries to read these but the lookup returns 0 — either a name typo in mapping, or the account genuinely has no balance)`);
  if (missingNames.length === 0) {
    console.log("  (none)");
  } else {
    for (const n of missingNames) {
      console.log(`  ${pad(n, 45)} → ${BS_MAPPING[n]}`);
    }
  }

  // Direct BS line dump for the user to compare against the workbook.
  console.log("");
  console.log("=== Computed BS lines (for cross-check with workbook) ===");
  console.log("Non-Current Assets:");
  for (const l of balanceSheet.nonCurrentAssets) console.log(`  ${pad(l.label, 42)} ${padR(bdt(l.amount), 18)}`);
  console.log("Current Assets:");
  for (const l of balanceSheet.currentAssets) console.log(`  ${pad(l.label, 42)} ${padR(bdt(l.amount), 18)}`);
  console.log("Equity:");
  for (const l of balanceSheet.equity) console.log(`  ${pad(l.label, 42)} ${padR(bdt(l.amount), 18)}`);
  console.log("Non-Current Liabilities:");
  for (const l of balanceSheet.nonCurrentLiabilities) console.log(`  ${pad(l.label, 42)} ${padR(bdt(l.amount), 18)}`);
  console.log("Current Liabilities:");
  for (const l of balanceSheet.currentLiabilities) console.log(`  ${pad(l.label, 42)} ${padR(bdt(l.amount), 18)}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
