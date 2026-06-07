/* eslint-disable */
// Consistency guard: every trade-backed voucher (BV/SV) must agree with
// its trade row. Flags the exact split that arises when someone "fixes" a
// trade by editing its journal voucher instead of the trade (which leaves
// the trade row — and the portfolio — stale).
//
// For each Trade with a journalBatchId, checks:
//   1. the voucher balances (Σdebit == Σcredit),
//   2. the investment-leg amount == trade-implied
//        BUY  → gross + commission
//        SELL → costBasis (row),
//   3. journal entry_date == trade tradeDate.
//
// Exit code 1 if any split is found (usable as a CI/pre-deploy check).
// Run: npx tsx scripts/diag-trade-journal-sync.ts

import { config } from "dotenv";
config({ path: ".env" });

import { PrismaClient } from "@/generated/prisma";

const prisma = new PrismaClient();

const r2 = (n: number) => Math.round(n * 100) / 100;

async function main() {
  const trades = await prisma.trade.findMany({
    where: { journalBatchId: { not: null } },
    orderBy: [{ tradeDate: "asc" }, { createdAt: "asc" }],
  });

  console.log(`Trade-backed vouchers to check: ${trades.length}\n`);

  let problems = 0;
  for (const t of trades) {
    const lines = await prisma.journal.findMany({ where: { batchId: t.journalBatchId! } });
    const issues: string[] = [];

    if (lines.length === 0) {
      issues.push("NO journal lines (voucher missing)");
    } else {
      const sumDr = lines.reduce((s, l) => s + Number(l.debit), 0);
      const sumCr = lines.reduce((s, l) => s + Number(l.credit), 0);
      if (Math.abs(sumDr - sumCr) > 0.01) issues.push(`unbalanced dr ${sumDr.toFixed(2)} / cr ${sumCr.toFixed(2)}`);

      const gross = Number(t.grossAmount);
      const comm = Number(t.commission ?? 0);
      if (t.side === "BUY") {
        const expected = r2(gross + comm);
        const invDr = lines.filter((l) => l.accountName.includes("Investment")).reduce((s, l) => s + Number(l.debit), 0);
        if (Math.abs(invDr - expected) > 0.01)
          issues.push(`investment Dr ${invDr.toFixed(2)} != trade-implied ${expected.toFixed(2)} (rate ${Number(t.rate)}, comm ${comm})`);
      } else {
        const expected = r2(Number(t.costBasis ?? 0));
        const invCr = lines.filter((l) => l.accountName.includes("Investment")).reduce((s, l) => s + Number(l.credit), 0);
        if (Math.abs(invCr - expected) > 0.01)
          issues.push(`investment Cr ${invCr.toFixed(2)} != trade costBasis ${expected.toFixed(2)}`);
      }

      const jDate = lines[0].entryDate.toISOString().slice(0, 10);
      const tDate = t.tradeDate.toISOString().slice(0, 10);
      if (jDate !== tDate) issues.push(`date journal ${jDate} != trade ${tDate}`);
    }

    if (issues.length) {
      problems++;
      console.log(`  ✗ ${t.tradeDate.toISOString().slice(0, 10)} ${t.side} ${t.instrumentCode} q${Number(t.quantity)}@${Number(t.rate)}`);
      for (const i of issues) console.log(`        - ${i}`);
    }
  }

  console.log("");
  if (problems === 0) {
    console.log("✓ All trade-backed vouchers agree with their trade rows.");
  } else {
    console.log(`✗ ${problems} voucher(s) out of sync with the trade row. Fix by editing the trade at /trades/<id>/edit.`);
    process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
