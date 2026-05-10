// Diff TB-C col G (account names used by financial-statement formulas)
// against CHART_OF_ACCOUNTS_SEED. Flags renames so we can decide which
// form to canonicalize on.
import ExcelJS, { type CellRichTextValue, type CellFormulaValue } from "exceljs";
import path from "node:path";
import { CHART_OF_ACCOUNTS_SEED } from "../prisma/seed/chart-of-accounts";

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

  const tbNames = new Set<string>();
  for (let r = 7; r <= sheet.rowCount; r++) {
    const name = cellText(sheet.getRow(r).getCell(7).value).trim();
    if (name) tbNames.add(name);
  }
  const coaNames = new Set(CHART_OF_ACCOUNTS_SEED.map((a) => a.name));

  const onlyInTb = [...tbNames].filter((n) => !coaNames.has(n));
  const onlyInCoa = [...coaNames].filter((n) => !tbNames.has(n));

  console.log(`TB-C col G has ${tbNames.size} unique names; CoA seed has ${coaNames.size}.`);
  console.log(`\nNames in TB-C but NOT in CoA seed (${onlyInTb.length}):`);
  for (const n of onlyInTb.sort()) console.log("  -", JSON.stringify(n));
  console.log(`\nNames in CoA seed but NOT in TB-C (${onlyInCoa.length}):`);
  for (const n of onlyInCoa.sort()) console.log("  -", JSON.stringify(n));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
