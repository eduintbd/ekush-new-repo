// One-off: list every sheet in the workbook + count notes-like sheets,
// then dump the first ~120 rows of each "Notes" sheet so we can design
// the Notes schema (task 6).
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

  console.log("=== ALL SHEETS ===");
  wb.worksheets.forEach((s) => {
    console.log(`  ${s.name.padEnd(20)} rows=${s.rowCount} cols=${s.actualColumnCount}`);
  });

  for (const sheet of wb.worksheets) {
    if (!/notes/i.test(sheet.name)) continue;
    console.log(`\n=== ${sheet.name} ===`);
    const maxRow = sheet.rowCount;
    for (let r = 1; r <= maxRow; r++) {
      const row = sheet.getRow(r);
      const cells: string[] = [];
      const colCount = Math.min(8, sheet.actualColumnCount || 8);
      for (let c = 1; c <= colCount; c++) {
        cells.push(cellText(row.getCell(c).value).trim());
      }
      if (cells.every((c) => !c)) continue;
      console.log(`r${String(r).padStart(3, " ")}:`, cells.map((s) => s.length > 50 ? s.slice(0, 50) + "…" : s).join(" | "));
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
