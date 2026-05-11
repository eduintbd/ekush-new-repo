// Dumps Notes. (2) with formulas, so we can map F4 / F11 / F12 back to TB-C
// cells and derive the current-tax provision automatically.
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

function cellFormula(value: ExcelJS.CellValue): string {
  if (value && typeof value === "object" && "formula" in value) {
    return String((value as { formula: unknown }).formula ?? "");
  }
  return "";
}

async function main() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.resolve("docs/F.S March 2026.xlsx"));
  const sheet = wb.getWorksheet("Notes. (2)");
  if (!sheet) throw new Error("Notes. (2) not found");
  console.log(`\n=== ${sheet.name} ===`);
  for (let r = 1; r <= 15; r++) {
    const row = sheet.getRow(r);
    const cells: string[] = [];
    for (let c = 1; c <= 8; c++) {
      const v = row.getCell(c).value;
      const text = cellText(v).trim();
      const f = cellFormula(v);
      const col = String.fromCharCode(64 + c);
      cells.push(f ? `${col}${r}=${f}→${text}` : text ? `${col}${r}:${text}` : "");
    }
    const nonEmpty = cells.filter(Boolean);
    if (nonEmpty.length) console.log(`r${String(r).padStart(2, " ")}:`, nonEmpty.join(" | "));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
