// One-shot loader: import the 919 journal rows from F.S March 2026.xlsx into
// xsystem.journals for FY2025-26. Run idempotently — refuses to insert if
// FY2025-26 already has journals (pass --force to wipe + reload).
//
//   npx tsx scripts/load-journals-from-workbook.ts          (safe; bails if journals exist)
//   npx tsx scripts/load-journals-from-workbook.ts --force  (wipe FY2025-26 journals first)

import ExcelJS, { type CellRichTextValue, type CellFormulaValue } from "exceljs";
import path from "node:path";
import crypto from "node:crypto";
import { PrismaClient } from "../src/generated/prisma";

// ─── Workbook helpers ────────────────────────────────────────────

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

// ─── Name remap: workbook journal spelling → seeded CoA spelling ───

const REMAP: Record<string, string> = {
  "AIT Receivable against Management Fee": "AIT Receivables against Management Fee",
  "Bkash (DM4952)": "Bkash(DM4952)",
  "Capital loss": "Capital Gain/ loss",
  "Dividend income": "Dividend Income",
  "Interest on Margin Loan": "Interest on Margin  Loan", // two spaces in seed
  "Internet bill": "Internet Bill",
  "Membership Expenses": "Membership Expense",
  "Mobile Bill": "Mobile bill",
  "Office Equipment": "Office Equipments",
  "Withholding VAT & TDS": "Withholding VAT & TDs",
};

// Accounts present in the journals but absent from the seed CoA — created on the fly.
// Normal balance inferred from accounting nature; verify post-load by checking TB balance.
const NEW_ACCOUNTS: Array<{ name: string; normalBalance: "DEBIT" | "CREDIT"; category?: string }> = [
  { name: "Liab For Employee Allowance", normalBalance: "CREDIT", category: "Current liabilities" },
  { name: "Liab: For PF Fund", normalBalance: "CREDIT", category: "Current liabilities" },
  { name: "Management Fee Accrued", normalBalance: "DEBIT", category: "Receivables" },
  { name: "Salary and Allowances", normalBalance: "DEBIT", category: "Expenses" },
  { name: "UCB BO (1205590068173895)", normalBalance: "DEBIT", category: "Cash and bank balances" },
  { name: "Wages", normalBalance: "DEBIT", category: "Expenses" },
];

// ─── Main ────────────────────────────────────────────────────────

async function main() {
  const force = process.argv.includes("--force");
  const prisma = new PrismaClient();

  // Resolve FY
  const fy = await prisma.fiscalYear.findUnique({ where: { label: "FY2025-26" } });
  if (!fy) {
    console.error("FY2025-26 not found. Run `npm run db:seed` first.");
    process.exit(1);
  }

  // Idempotency check
  const existing = await prisma.journal.count({ where: { fiscalYearId: fy.id } });
  if (existing > 0) {
    if (!force) {
      console.error(
        `FY2025-26 already has ${existing} journal rows. Pass --force to wipe and reload.`,
      );
      process.exit(1);
    }
    console.log(`--force: wiping ${existing} existing journals for FY2025-26…`);
    await prisma.journal.deleteMany({ where: { fiscalYearId: fy.id } });
  }

  // Create missing accounts (idempotent: upsert)
  console.log(`Ensuring ${NEW_ACCOUNTS.length} new chart-of-accounts entries…`);
  const maxSl = await prisma.chartOfAccount.aggregate({ _max: { sl: true } });
  let nextSl = (maxSl._max.sl ?? 0) + 1;
  for (const na of NEW_ACCOUNTS) {
    await prisma.chartOfAccount.upsert({
      where: { name: na.name },
      create: {
        name: na.name,
        sl: nextSl++,
        normalBalance: na.normalBalance,
        category: na.category,
      },
      update: {},
    });
  }

  // Load workbook
  console.log("Reading docs/F.S March 2026.xlsx…");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.resolve("docs/F.S March 2026.xlsx"));
  const sheet = wb.getWorksheet("Journals")!;

  // Validate all referenced accounts exist
  const allCoa = await prisma.chartOfAccount.findMany({ select: { name: true } });
  const coaSet = new Set(allCoa.map((a) => a.name));

  type Row = {
    entryDate: Date;
    description: string;
    txnType: string;
    accountName: string;
    debit: number;
    credit: number;
    rowNum: number;
  };

  const rows: Row[] = [];
  const unmatched = new Set<string>();

  for (let r = 8; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const year = cellNum(row.getCell(1).value);
    const month = cellNum(row.getCell(2).value);
    const day = cellNum(row.getCell(3).value);
    if (!year || !month || !day) continue;

    const description = cellText(row.getCell(5).value).trim();
    const txnType = cellText(row.getCell(6).value).trim();
    let accountName = cellText(row.getCell(7).value).trim();
    const debit = cellNum(row.getCell(8).value);
    const credit = cellNum(row.getCell(9).value);

    if (!accountName) continue;

    // Apply remap
    if (REMAP[accountName]) accountName = REMAP[accountName];

    if (!coaSet.has(accountName)) {
      unmatched.add(accountName);
      continue;
    }

    const entryDate = new Date(Date.UTC(year, month - 1, day));
    rows.push({ entryDate, description, txnType, accountName, debit, credit, rowNum: r });
  }

  if (unmatched.size > 0) {
    console.error("\nUnmatched accounts (will be skipped):");
    for (const n of unmatched) console.error(`  - "${n}"`);
    console.error("\nAborting; remap these in the script first.");
    process.exit(1);
  }

  console.log(`Parsed ${rows.length} valid journal rows.`);

  // Group rows into batches by (date, description, txnType)
  const batchKey = (r: Row) => `${r.entryDate.toISOString().slice(0, 10)}|${r.txnType}|${r.description}`;
  const batchIds = new Map<string, string>();
  for (const r of rows) {
    const k = batchKey(r);
    if (!batchIds.has(k)) batchIds.set(k, crypto.randomUUID());
  }
  console.log(`Grouped into ${batchIds.size} batches.`);

  // Bulk-insert in chunks of 200
  const payload = rows.map((r) => ({
    entryDate: r.entryDate,
    description: r.description || null,
    txnType: r.txnType || null,
    accountName: r.accountName,
    debit: r.debit,
    credit: r.credit,
    fiscalYearId: fy.id,
    batchId: batchIds.get(batchKey(r))!,
  }));

  const CHUNK = 200;
  let inserted = 0;
  for (let i = 0; i < payload.length; i += CHUNK) {
    const slice = payload.slice(i, i + CHUNK);
    await prisma.journal.createMany({ data: slice });
    inserted += slice.length;
    process.stdout.write(`\rInserted ${inserted}/${payload.length}…`);
  }
  console.log("");

  // Verify totals
  const totals = await prisma.journal.aggregate({
    where: { fiscalYearId: fy.id },
    _sum: { debit: true, credit: true },
  });
  const td = Number(totals._sum.debit ?? 0);
  const tc = Number(totals._sum.credit ?? 0);
  console.log(`\nDB totals — debit: ${td.toFixed(2)}  credit: ${tc.toFixed(2)}  delta: ${(td - tc).toFixed(2)}`);
  console.log(`Workbook expected: 187,881,009.56 / 187,881,009.56`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
