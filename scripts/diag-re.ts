/* eslint-disable */
// One-off: figure out why Retained Earnings differs from the workbook.
// Shows OB row, FY-period activity, IS profit, and the assembled RE line.

import { config } from "dotenv";
config({ path: ".env" });

import { PrismaClient } from "@/generated/prisma";
import { getStatements } from "@/lib/statements";

const prisma = new PrismaClient();

async function main() {
  const fy = await prisma.fiscalYear.findFirst({
    orderBy: { startsOn: "desc" },
    select: { id: true, label: true, startsOn: true, endsOn: true },
  });
  if (!fy) throw new Error("No fiscal year");
  console.log(`Fiscal year: ${fy.label}\n`);

  // 1. Raw journal aggregate on "Retained Earning"
  const reAgg = await prisma.journal.aggregate({
    where: { accountName: "Retained Earning" },
    _sum: { debit: true, credit: true },
  });
  const reGrossDr = Number(reAgg._sum.debit ?? 0);
  const reGrossCr = Number(reAgg._sum.credit ?? 0);
  console.log("=== Retained Earning account (all time) ===");
  console.log(`  Σ debit            ${reGrossDr.toLocaleString("en-IN")}`);
  console.log(`  Σ credit           ${reGrossCr.toLocaleString("en-IN")}`);
  console.log(`  Net balance (Dr − Cr)  ${(reGrossDr - reGrossCr).toLocaleString("en-IN")}`);
  console.log(`  Net Dr (for netD)  ${Math.max(0, reGrossDr - reGrossCr).toLocaleString("en-IN")}`);
  console.log(`  Net Cr (for netC)  ${Math.max(0, reGrossCr - reGrossDr).toLocaleString("en-IN")}`);

  // 2. Every line on Retained Earning, ordered
  const lines = await prisma.journal.findMany({
    where: { accountName: "Retained Earning" },
    orderBy: { entryDate: "asc" },
    select: {
      entryDate: true,
      voucherNo: true,
      txnType: true,
      debit: true,
      credit: true,
      description: true,
    },
  });
  console.log(`\n=== All ${lines.length} journal entries on "Retained Earning" ===`);
  for (const l of lines.slice(0, 30)) {
    console.log(
      `  ${l.entryDate.toISOString().slice(0, 10)} ${(l.voucherNo ?? "").padEnd(15)} ${(l.txnType ?? "").padEnd(4)} Dr ${Number(l.debit).toLocaleString("en-IN").padStart(14)}  Cr ${Number(l.credit).toLocaleString("en-IN").padStart(14)}  ${l.description ?? ""}`,
    );
  }

  // 3. Income Statement profit (from getStatements)
  console.log("\n=== Income Statement summary ===");
  const stmts = await getStatements(fy.id);
  console.log(`  Profit before tax    ${stmts.incomeStatement.profitBeforeTax.toLocaleString("en-IN", { minimumFractionDigits: 2 })}`);
  console.log(`  Profit for period    ${stmts.incomeStatement.profitForPeriod.toLocaleString("en-IN", { minimumFractionDigits: 2 })}`);
  console.log(`  Total comprehensive  ${stmts.incomeStatement.totalComprehensiveIncome.toLocaleString("en-IN", { minimumFractionDigits: 2 })}`);

  // 4. Assembled RE line as it currently goes onto the BS
  const reCr = Math.max(0, reGrossCr - reGrossDr);
  const reDr = Math.max(0, reGrossDr - reGrossCr);
  const liveBsRe = reCr + stmts.incomeStatement.profitForPeriod;
  const signedBsRe = -reDr + reCr + stmts.incomeStatement.profitForPeriod;
  console.log("\n=== Retained Earnings on BS ===");
  console.log(`  Current formula  netC(RE) + IS.profit  = ${reCr.toLocaleString("en-IN")} + ${stmts.incomeStatement.profitForPeriod.toLocaleString("en-IN")} = ${liveBsRe.toLocaleString("en-IN", { minimumFractionDigits: 2 })}`);
  console.log(`  Signed formula   netCr − netDr + IS.profit = ${signedBsRe.toLocaleString("en-IN", { minimumFractionDigits: 2 })}`);
  console.log(`  Workbook expects                                          29,48,292.00`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
