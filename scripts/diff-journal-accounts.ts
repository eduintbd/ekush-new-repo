import ExcelJS, { type CellRichTextValue, type CellFormulaValue } from "exceljs";
import path from "node:path";
import { PrismaClient } from "../src/generated/prisma";

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

async function main() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.resolve("docs/F.S March 2026.xlsx"));
  const sheet = wb.getWorksheet("Journals")!;

  const journalAccounts = new Set<string>();
  for (let r = 8; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const account = cellText(row.getCell(7).value).trim();
    const year = row.getCell(1).value;
    if (account && year) journalAccounts.add(account);
  }

  const prisma = new PrismaClient();
  const seeded = await prisma.chartOfAccount.findMany({ select: { name: true } });
  const seededSet = new Set(seeded.map((s) => s.name));
  await prisma.$disconnect();

  const missing: string[] = [];
  const matched: string[] = [];
  for (const a of journalAccounts) {
    if (seededSet.has(a)) matched.push(a);
    else missing.push(a);
  }

  console.log(`Workbook journals reference ${journalAccounts.size} unique account names`);
  console.log(`  ✓ Matched in CoA seed: ${matched.length}`);
  console.log(`  ✗ Missing from seed:   ${missing.length}`);

  if (missing.length > 0) {
    console.log("\nMissing from seed (will need to add or remap):");
    for (const m of missing.sort()) console.log(`  - ${m}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
