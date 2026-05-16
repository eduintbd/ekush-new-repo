import ExcelJS, { type CellRichTextValue, type CellFormulaValue } from "exceljs";
import path from "node:path";

function cellText(v: ExcelJS.CellValue): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const rt = v as Partial<CellRichTextValue>;
    if (Array.isArray(rt.richText)) return rt.richText.map((p) => p.text).join("");
    const fv = v as Partial<CellFormulaValue>;
    if (fv.result !== undefined) return cellText(fv.result as ExcelJS.CellValue);
  }
  return "";
}

function cellNum(v: ExcelJS.CellValue): number {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "string") return parseFloat(v) || 0;
  if (typeof v === "object") {
    const fv = v as Partial<CellFormulaValue>;
    if (fv.result !== undefined) return cellNum(fv.result as ExcelJS.CellValue);
  }
  return 0;
}

async function main() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.resolve("docs/F.S March 2026.xlsx"));
  const sheet = wb.getWorksheet("Journals")!;

  let lastDataRow = 0;
  let earliestDate = "9999-99-99";
  let latestDate = "0000-00-00";
  const txnTypeCounts: Record<string, number> = {};
  const monthCounts: Record<string, number> = {};
  let totalDebit = 0;
  let totalCredit = 0;
  let rowCount = 0;
  const accountsSeen = new Set<string>();
  const sampleByType: Record<string, string[]> = {};

  for (let r = 8; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const year = cellNum(row.getCell(1).value);
    const month = cellNum(row.getCell(2).value);
    const day = cellNum(row.getCell(3).value);
    const txn = cellText(row.getCell(5).value).trim();
    const txnType = cellText(row.getCell(6).value).trim();
    const account = cellText(row.getCell(7).value).trim();
    const debit = cellNum(row.getCell(8).value);
    const credit = cellNum(row.getCell(9).value);

    if (!year || !account) continue;
    lastDataRow = r;
    rowCount++;

    const ymd = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (ymd < earliestDate) earliestDate = ymd;
    if (ymd > latestDate) latestDate = ymd;

    txnTypeCounts[txnType || "(blank)"] = (txnTypeCounts[txnType || "(blank)"] ?? 0) + 1;
    const ym = `${year}-${String(month).padStart(2, "0")}`;
    monthCounts[ym] = (monthCounts[ym] ?? 0) + 1;
    totalDebit += debit;
    totalCredit += credit;
    accountsSeen.add(account);

    if (!sampleByType[txnType]) sampleByType[txnType] = [];
    if (sampleByType[txnType].length < 2) {
      sampleByType[txnType].push(`r${r}: ${ymd} | ${account} | D=${debit} C=${credit} | ${txn.slice(0, 50)}`);
    }
  }

  console.log(`Last data row: ${lastDataRow}`);
  console.log(`Total data rows: ${rowCount}`);
  console.log(`Date range: ${earliestDate} → ${latestDate}`);
  console.log(`Total debit:  ${totalDebit.toFixed(2)}`);
  console.log(`Total credit: ${totalCredit.toFixed(2)}`);
  console.log(`Net (D − C):  ${(totalDebit - totalCredit).toFixed(2)}`);
  console.log(`Unique accounts referenced: ${accountsSeen.size}`);
  console.log("");
  console.log("By transaction type:");
  for (const [k, v] of Object.entries(txnTypeCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(15)} ${v}`);
  }
  console.log("");
  console.log("By month:");
  for (const [k, v] of Object.entries(monthCounts).sort()) {
    console.log(`  ${k}  ${v}`);
  }
  console.log("");
  console.log("Sample by txn type:");
  for (const [k, samples] of Object.entries(sampleByType)) {
    console.log(`  [${k}]`);
    samples.forEach((s) => console.log(`    ${s}`));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
