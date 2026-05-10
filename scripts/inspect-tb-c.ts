// Dump the TB-C row → account name mapping in full so we can translate
// spec §5.11 cell refs (TB-C!K7, L17, …) into chart_of_accounts names.
import ExcelJS, { type CellRichTextValue, type CellFormulaValue } from "exceljs";
import path from "node:path";

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

async function main() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.resolve("docs/F.S March 2026.xlsx"));
  const sheet = wb.getWorksheet("TB-C")!;

  console.log(`TB-C rowCount=${sheet.rowCount}`);
  console.log("\nrow → account_name (col G), with K (net debit) and L (net credit) where set");
  console.log("rowG  | account name                                           | K (net debit)        | L (net credit)");
  console.log("------+--------------------------------------------------------+----------------------+--------------------");

  for (let r = 7; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const account = cellText(row.getCell(7).value).trim(); // col G
    const k = cellText(row.getCell(11).value).trim();
    const l = cellText(row.getCell(12).value).trim();
    if (!account && !k && !l) continue;
    console.log(
      `r${String(r).padStart(3, " ")} | ${account.padEnd(54)} | ${k.padEnd(20)} | ${l}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
