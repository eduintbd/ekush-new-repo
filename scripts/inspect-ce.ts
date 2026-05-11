// Dumps the workbook's CE sheet so we can grade `statement_mapping.ts`
// against it when implementing Statement of Changes in Equity.
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

async function dumpSheet(wb: ExcelJS.Workbook, sheetName: string) {
  const sheet = wb.getWorksheet(sheetName);
  if (!sheet) {
    console.log(`Sheet "${sheetName}" not found`);
    return;
  }
  console.log(
    `\n=== ${sheetName} (rowCount=${sheet.rowCount}, colCount=${sheet.actualColumnCount}) ===`,
  );
  for (let r = 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const cells: string[] = [];
    for (let c = 1; c <= Math.min(10, sheet.actualColumnCount || 10); c++) {
      const v = row.getCell(c).value;
      const text = cellText(v).trim();
      const f = cellFormula(v);
      cells.push(f ? `${text} =${f}` : text);
    }
    if (cells.every((c) => !c)) continue;
    console.log(
      `r${String(r).padStart(3, " ")}:`,
      cells.map((s) => (s.length > 60 ? s.slice(0, 60) + "…" : s)).join(" | "),
    );
  }
}

async function main() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.resolve("docs/F.S March 2026.xlsx"));
  for (const name of wb.worksheets.map((s) => s.name)) {
    console.log(`- ${name}`);
  }
  await dumpSheet(wb, "CE");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
