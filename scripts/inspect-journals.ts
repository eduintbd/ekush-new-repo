import ExcelJS, { type CellRichTextValue, type CellFormulaValue } from "exceljs";
import path from "node:path";

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
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
  const sheet = wb.getWorksheet("Journals")!;

  console.log(`Journals rowCount=${sheet.rowCount}  colCount=${sheet.columnCount}`);

  // Header rows — print rows 1-5 so we see the column layout
  console.log("\n=== FIRST 5 ROWS ===");
  for (let r = 1; r <= Math.min(5, sheet.rowCount); r++) {
    const row = sheet.getRow(r);
    const cells: string[] = [];
    for (let c = 1; c <= sheet.columnCount; c++) {
      cells.push(cellText(row.getCell(c).value));
    }
    console.log(`r${r}: ${cells.map((x, i) => `${String.fromCharCode(64 + i + 1)}=${x}`).filter((x) => !x.endsWith("=")).join(" | ")}`);
  }

  // Sample rows from middle and end
  console.log("\n=== ROWS 6-20 (data start) ===");
  for (let r = 6; r <= Math.min(20, sheet.rowCount); r++) {
    const row = sheet.getRow(r);
    const cells: string[] = [];
    for (let c = 1; c <= 14; c++) {
      cells.push(cellText(row.getCell(c).value));
    }
    console.log(`r${String(r).padStart(4, " ")}: ${cells.join(" | ")}`);
  }

  console.log("\n=== LAST 10 ROWS ===");
  for (let r = Math.max(1, sheet.rowCount - 9); r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const cells: string[] = [];
    for (let c = 1; c <= 14; c++) {
      cells.push(cellText(row.getCell(c).value));
    }
    console.log(`r${String(r).padStart(4, " ")}: ${cells.join(" | ")}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
