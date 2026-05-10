// Dumps the workbook's BS. and IS. sheets so we can compare each line
// label + computed value against statement_mapping.ts.
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

async function dumpSheet(wb: ExcelJS.Workbook, sheetName: string) {
  const sheet = wb.getWorksheet(sheetName);
  if (!sheet) {
    console.log(`Sheet "${sheetName}" not found`);
    return;
  }
  console.log(`\n=== ${sheetName} (rowCount=${sheet.rowCount}, colCount=${sheet.actualColumnCount}) ===`);
  for (let r = 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const cells: string[] = [];
    for (let c = 1; c <= Math.min(8, sheet.actualColumnCount || 8); c++) {
      cells.push(cellText(row.getCell(c).value).trim());
    }
    if (cells.every((c) => !c)) continue;
    console.log(`r${String(r).padStart(3, " ")}:`, cells.map((s) => s.length > 40 ? s.slice(0, 40) + "…" : s).join(" | "));
  }
}

async function main() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.resolve("docs/F.S March 2026.xlsx"));
  await dumpSheet(wb, "BS.");
  await dumpSheet(wb, "IS.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
