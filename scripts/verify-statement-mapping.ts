// Verifies src/lib/statement_mapping.ts against the source workbook.
//
// 1. Builds a synthetic TrialBalance from TB-C col G (account name) plus
//    cols H/I/K/L (gross/net debit/credit) for the period.
// 2. Reads ExternalInputs from Annexure march, Notes.(2), and IS. itself
//    (where the BS. references IS! values).
// 3. Runs buildIncomeStatement / buildBalanceSheet.
// 4. Reports each line's computed value. Manual cross-check against the
//    workbook's IS./BS. sheets is still required — we don't yet have a
//    machine-readable label→cell map for those sheets, so for now the
//    verification surfaces the numbers and the operator confirms.
import ExcelJS, { type CellRichTextValue, type CellFormulaValue } from "exceljs";
import path from "node:path";
import {
  buildIncomeStatement,
  buildBalanceSheet,
  type AccountAggregate,
  type ExternalInputs,
  type TrialBalance,
} from "../src/lib/statement_mapping";

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const rt = value as Partial<CellRichTextValue>;
    if (Array.isArray(rt.richText)) return rt.richText.map((p) => p.text).join("");
    const fv = value as Partial<CellFormulaValue>;
    if (fv.result !== undefined) return cellText(fv.result as ExcelJS.CellValue);
    if ("text" in value && typeof (value as { text: unknown }).text === "string") {
      return (value as { text: string }).text;
    }
  }
  return "";
}

function num(value: ExcelJS.CellValue): number {
  const t = cellText(value).trim();
  if (!t) return 0;
  const n = Number(t);
  return Number.isFinite(n) ? n : 0;
}

const fmt = (n: number) =>
  n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function main() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.resolve("docs/F.S March 2026.xlsx"));

  // Build the synthetic trial balance from TB-C
  const tbSheet = wb.getWorksheet("TB-C")!;
  const tb: TrialBalance = new Map();
  for (let r = 7; r <= tbSheet.rowCount; r++) {
    const row = tbSheet.getRow(r);
    const name = cellText(row.getCell(7).value).trim();
    if (!name) continue;
    const grossDebit = num(row.getCell(8).value);
    const grossCredit = num(row.getCell(9).value);
    const netDebit = num(row.getCell(11).value);
    const netCredit = num(row.getCell(12).value);
    const agg: AccountAggregate = { grossDebit, grossCredit, netDebit, netCredit };
    tb.set(name, agg);
  }
  console.log(`TrialBalance built from TB-C: ${tb.size} accounts.`);

  // External inputs — pull from the appropriate cells.
  // For the verification pass we read them directly; in production these
  // come from the Notes / Annexure tables.
  const annexure = wb.getWorksheet("Annexure march");
  const unrealisedFairValueLoss = annexure ? num(annexure.getCell("K27").value) : 0;
  const notes2 = wb.getWorksheet("Notes. (2)") ?? wb.getWorksheet("Notes.(2)");
  const currentTaxProvision = notes2 ? num(notes2.getCell("F12").value) : 0;

  const ext: ExternalInputs = {
    unrealisedFairValueLoss,
    currentTaxProvision,
    fairValueReceivableAdjustment: 0, // Annexure!M131 — verify cell exists
    currentPeriodNetProfit: 0,
    currentPeriodTaxExpense: 0,
  };
  console.log(
    `Inputs — unrealised loss: ${fmt(unrealisedFairValueLoss)}, current tax provision: ${fmt(currentTaxProvision)}`,
  );

  // First pass — IS without the loop-back inputs
  const is1 = buildIncomeStatement(tb, ext);
  ext.currentPeriodNetProfit = is1.profitForPeriod;
  ext.currentPeriodTaxExpense = is1.taxExpense.reduce((s, l) => s + l.amount, 0);

  console.log("\n=== Income Statement (computed) ===");
  console.log("Operating Income:");
  for (const l of is1.operatingIncome) console.log(`  ${l.label.padEnd(40)} ${fmt(l.amount).padStart(20)}`);
  console.log("Operating Expenses:");
  for (const l of is1.operatingExpenses) console.log(`  ${l.label.padEnd(40)} ${fmt(l.amount).padStart(20)}`);
  console.log("Financial Expenses:");
  for (const l of is1.financialExpenses) console.log(`  ${l.label.padEnd(40)} ${fmt(l.amount).padStart(20)}`);
  console.log(`  ${"Profit Before Tax".padEnd(40)} ${fmt(is1.profitBeforeTax).padStart(20)}`);
  console.log("Tax:");
  for (const l of is1.taxExpense) console.log(`  ${l.label.padEnd(40)} ${fmt(l.amount).padStart(20)}`);
  console.log(`  ${"Profit For Period".padEnd(40)} ${fmt(is1.profitForPeriod).padStart(20)}`);
  console.log("OCI:");
  for (const l of is1.oci) console.log(`  ${l.label.padEnd(40)} ${fmt(l.amount).padStart(20)}`);
  console.log(`  ${"Total Comprehensive Income".padEnd(40)} ${fmt(is1.totalComprehensiveIncome).padStart(20)}`);

  const bs = buildBalanceSheet(tb, ext);

  console.log("\n=== Balance Sheet (computed) ===");
  console.log("Non-current Assets:");
  for (const l of bs.nonCurrentAssets) console.log(`  ${l.label.padEnd(40)} ${fmt(l.amount).padStart(20)}`);
  console.log("Current Assets:");
  for (const l of bs.currentAssets) console.log(`  ${l.label.padEnd(40)} ${fmt(l.amount).padStart(20)}`);
  console.log(`  ${"TOTAL ASSETS".padEnd(40)} ${fmt(bs.totalAssets).padStart(20)}`);
  console.log("Equity:");
  for (const l of bs.equity) console.log(`  ${l.label.padEnd(40)} ${fmt(l.amount).padStart(20)}`);
  console.log("Non-current Liabilities:");
  for (const l of bs.nonCurrentLiabilities) console.log(`  ${l.label.padEnd(40)} ${fmt(l.amount).padStart(20)}`);
  console.log("Current Liabilities:");
  for (const l of bs.currentLiabilities) console.log(`  ${l.label.padEnd(40)} ${fmt(l.amount).padStart(20)}`);
  console.log(`  ${"TOTAL EQUITY + LIABILITIES".padEnd(40)} ${fmt(bs.totalEquityAndLiabilities).padStart(20)}`);

  const balance = bs.totalAssets - bs.totalEquityAndLiabilities;
  console.log(
    `\nBS check: Assets − (Equity + Liabilities) = ${fmt(balance)} ${
      Math.abs(balance) < 1 ? "✓ balanced (< BDT 1)" : "✗ OUT OF BALANCE"
    }`,
  );

  if (Math.abs(balance) >= 1) {
    console.error("\nFATAL: balance sheet does not balance — mapping is broken.");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
