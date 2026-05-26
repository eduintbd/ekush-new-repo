/* eslint-disable */
import { config } from "dotenv";
config({ path: ".env" });

import { PrismaClient } from "@/generated/prisma";
const prisma = new PrismaClient();

const TARGETS = [
  "Bkash (DM4952)",
  "Midland (A/C No. 00011060000128)",
  "Internet Bill",
  "Capital Gain",
  "Salary and Allowances",
  "Withholding TAX Employees",
  "Withholding VAT & TDs",
  "Source Tax",
  "Management Fee Accrued",
];

async function main() {
  const fy = await prisma.fiscalYear.findFirst({
    where: { isClosed: false },
    orderBy: { startsOn: "desc" },
  });
  if (!fy) { console.log("No open FY"); return; }

  // Find any account in journals whose name contains the partial query
  // (since live system may use slightly different spelling)
  const partials = ["bkash", "midland", "internet", "capital gain", "salary", "tax", "vat", "management fee"];
  const accs = await prisma.journal.findMany({
    where: {
      fiscalYearId: fy.id,
      OR: partials.map(p => ({ accountName: { contains: p, mode: "insensitive" as const } })),
    },
    distinct: ["accountName"],
    select: { accountName: true },
  });
  const names = [...new Set(accs.map(a => a.accountName))].sort();
  console.log(`Live DB account names matching: ${names.length}`);

  // OB serial = 45838 → date 2025-06-30. Period = 2025-07-01 to 2026-06-30.
  const obDate = new Date("2025-06-30T00:00:00Z");
  const fyStart = new Date("2025-07-01T00:00:00Z");

  for (const name of names) {
    const obAgg = await prisma.journal.aggregate({
      where: { fiscalYearId: fy.id, accountName: name, entryDate: obDate },
      _sum: { debit: true, credit: true },
    });
    const perAgg = await prisma.journal.aggregate({
      where: { fiscalYearId: fy.id, accountName: name, entryDate: { gte: fyStart } },
      _sum: { debit: true, credit: true },
    });
    const obDr = Number(obAgg._sum.debit ?? 0);
    const obCr = Number(obAgg._sum.credit ?? 0);
    const pDr  = Number(perAgg._sum.debit ?? 0);
    const pCr  = Number(perAgg._sum.credit ?? 0);
    const closing = (obDr + pDr) - (obCr + pCr);
    console.log(`  "${name}"`);
    console.log(`      OB:      dr=${obDr.toLocaleString("en-IN",{minimumFractionDigits:2}).padStart(15)}  cr=${obCr.toLocaleString("en-IN",{minimumFractionDigits:2}).padStart(15)}`);
    console.log(`      period:  dr=${pDr.toLocaleString("en-IN",{minimumFractionDigits:2}).padStart(15)}  cr=${pCr.toLocaleString("en-IN",{minimumFractionDigits:2}).padStart(15)}`);
    console.log(`      closing (dr − cr) = ${closing.toLocaleString("en-IN",{minimumFractionDigits:2}).padStart(15)}`);
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
