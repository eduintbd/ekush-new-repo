/* eslint-disable */
// One-off: see what the Tax Provision post actually did.
// Inspects the latest TaxProvision row, its postings, and the journal
// activity on the four tax accounts split by OB vs period vs TX.

import { config } from "dotenv";
config({ path: ".env" });

import { PrismaClient } from "@/generated/prisma";

const prisma = new PrismaClient();

const ACCOUNTS = [
  "Income Tax Expense",
  "Provision for income tax",
  "Deferred Tax Expense",
  "Deferred Tax",
];

const fmt = (n: number) =>
  n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function main() {
  const fy = await prisma.fiscalYear.findFirst({
    orderBy: { startsOn: "desc" },
    select: { id: true, label: true, startsOn: true, endsOn: true },
  });
  if (!fy) throw new Error("No fiscal year");
  console.log(`FY: ${fy.label}  (${fy.startsOn.toISOString().slice(0, 10)} → ${fy.endsOn.toISOString().slice(0, 10)})\n`);

  console.log("=== TaxProvision rows for this FY (newest first) ===");
  const provisions = await prisma.taxProvision.findMany({
    where: { fiscalYearId: fy.id },
    orderBy: { computedAt: "desc" },
    take: 5,
    include: { postings: true },
  });
  if (provisions.length === 0) {
    console.log("  (none)");
  }
  for (const p of provisions) {
    console.log(`  ${p.computedAt.toISOString()}  status=${p.status}`);
    console.log(`    currentTaxTotal   = ${fmt(Number(p.currentTaxTotal))}`);
    console.log(`      cg              = ${fmt(Number(p.currentTaxCg))}`);
    console.log(`      dividend        = ${fmt(Number(p.currentTaxDividend))}`);
    console.log(`      interest        = ${fmt(Number(p.currentTaxInterest))}`);
    console.log(`      mgmt            = ${fmt(Number(p.currentTaxMgmt))}`);
    console.log(`    deferredTaxTotal  = ${fmt(Number(p.deferredTaxTotal))}`);
    console.log(`    varianceCurrent   = ${fmt(Number(p.varianceCurrent))}`);
    console.log(`    varianceDeferred  = ${fmt(Number(p.varianceDeferred))}`);
    console.log(`    ratesSnapshot     = ${JSON.stringify(p.ratesSnapshot)}`);
    console.log(`    basesSnapshot     = ${JSON.stringify(p.basesSnapshot)}`);
    for (const post of p.postings) {
      console.log(`    posting  ${post.type}  amount=${fmt(Number(post.amount))}  batch=${post.journalBatchId.slice(0, 8)}`);
    }
  }
  console.log();

  for (const accountName of ACCOUNTS) {
    console.log(`=== ${accountName} (FY ${fy.label}) ===`);

    // OB only
    const ob = await prisma.journal.aggregate({
      where: { fiscalYearId: fy.id, accountName, txnType: "OB" },
      _sum: { debit: true, credit: true },
    });
    const obDr = Number(ob._sum.debit ?? 0);
    const obCr = Number(ob._sum.credit ?? 0);

    // TX only (our voucher postings)
    const tx = await prisma.journal.aggregate({
      where: { fiscalYearId: fy.id, accountName, txnType: "TX" },
      _sum: { debit: true, credit: true },
    });
    const txDr = Number(tx._sum.debit ?? 0);
    const txCr = Number(tx._sum.credit ?? 0);

    // Other (manual JVs, neither OB nor TX)
    const other = await prisma.journal.aggregate({
      where: {
        fiscalYearId: fy.id,
        accountName,
        NOT: { txnType: { in: ["OB", "TX"] } },
      },
      _sum: { debit: true, credit: true },
    });
    const otherDr = Number(other._sum.debit ?? 0);
    const otherCr = Number(other._sum.credit ?? 0);

    const totalDr = obDr + txDr + otherDr;
    const totalCr = obCr + txCr + otherCr;

    console.log(`           ${"Debit".padStart(18)}  ${"Credit".padStart(18)}`);
    console.log(`  OB       ${fmt(obDr).padStart(18)}  ${fmt(obCr).padStart(18)}`);
    console.log(`  TX       ${fmt(txDr).padStart(18)}  ${fmt(txCr).padStart(18)}`);
    console.log(`  Other    ${fmt(otherDr).padStart(18)}  ${fmt(otherCr).padStart(18)}`);
    console.log(`  Total    ${fmt(totalDr).padStart(18)}  ${fmt(totalCr).padStart(18)}`);
    console.log(`  netD = max(0, ΣD-ΣC)  = ${fmt(Math.max(0, totalDr - totalCr))}`);
    console.log(`  netC = max(0, ΣC-ΣD)  = ${fmt(Math.max(0, totalCr - totalDr))}`);
    console.log();
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
