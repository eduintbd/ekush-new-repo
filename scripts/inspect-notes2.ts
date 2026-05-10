// Dump Notes. (2) — the worksheet that drives the income-tax line on IS.
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
  const candidates = wb.worksheets.filter((s) => /notes/i.test(s.name));
  console.log("Notes-like sheets:", candidates.map((s) => s.name));

  for (const sheet of candidates) {
    console.log(`\n=== ${sheet.name} (rowCount=${sheet.rowCount}, colCount=${sheet.actualColumnCount}) ===`);
    for (let r = 1; r <= sheet.rowCount; r++) {
      const row = sheet.getRow(r);
      const cells: string[] = [];
      for (let c = 1; c <= Math.min(8, sheet.actualColumnCount || 8); c++) {
        cells.push(cellText(row.getCell(c).value).trim());
      }
      if (cells.every((c) => !c)) continue;
      console.log(`r${String(r).padStart(3, " ")}:`, cells.map((s) => s.length > 30 ? s.slice(0, 30) + "…" : s).join(" | "));
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
