/* eslint-disable */
// One-off: bring the 2 stale trade rows back in line with their (already-
// corrected) vouchers, so the portfolio reflects the corrections.
//   • BANKASIA 2026-04-23: rate 21.50→21.25, commission 425→0 (gross 212,500)
//   • PRIMEBANK (2,000 @ 29): tradeDate 2026-06-05→2026-05-11
// The vouchers already hold these values; both are BUYs with no later SELLs
// depending on them, so a row update is sufficient (portfolio is a live
// replay of trades). Re-posts each voucher from the trade anyway, so the
// investment leg + date provably match.
//   npx tsx scripts/fix-desynced-trades.ts          # dry-run
//   npx tsx scripts/fix-desynced-trades.ts --apply

import { config } from "dotenv";
config({ path: ".env" });

import { PrismaClient } from "@/generated/prisma";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");

const FIXES = [
  {
    id: "3be0bcd1-2235-49ed-bf49-00ac049d1f2b",
    label: "BANKASIA 2026-04-23",
    data: { rate: 21.25, commission: 0, grossAmount: 212500 },
  },
  {
    id: "2e82d381-f470-43ff-858a-bc88a84ecf47",
    label: "PRIMEBANK 2,000 @ 29",
    data: { tradeDate: new Date("2026-05-11T00:00:00.000Z") },
  },
] as const;

async function repostVoucher(t: any) {
  if (!t.journalBatchId) return;
  const inst = await prisma.instrument.findUnique({ where: { code: t.instrumentCode } });
  if (!inst) throw new Error(`Instrument ${t.instrumentCode} missing`);
  const head = await prisma.journal.findFirst({
    where: { batchId: t.journalBatchId },
    select: { voucherNo: true, description: true, createdBy: true },
  });
  const gross = Number(t.grossAmount);
  const comm = Number(t.commission ?? 0);
  const buyCost = gross + comm; // BUY only here
  await prisma.journal.deleteMany({ where: { batchId: t.journalBatchId } });
  await prisma.journal.createMany({
    data: [
      { entryDate: t.tradeDate, description: head?.description ?? `BUY ${t.instrumentCode}`, txnType: "BV", voucherNo: head?.voucherNo, accountName: inst.investmentAccount, debit: buyCost, credit: 0, fiscalYearId: t.fiscalYearId, batchId: t.journalBatchId, instrumentCode: t.instrumentCode, createdBy: head?.createdBy },
      { entryDate: t.tradeDate, description: head?.description ?? `BUY ${t.instrumentCode}`, txnType: "BV", voucherNo: head?.voucherNo, accountName: t.bankAccount, debit: 0, credit: buyCost, fiscalYearId: t.fiscalYearId, batchId: t.journalBatchId, instrumentCode: t.instrumentCode, createdBy: head?.createdBy },
    ],
  });
}

async function main() {
  console.log(`Fix desynced trades — ${APPLY ? "APPLY" : "DRY-RUN"}\n`);
  for (const f of FIXES) {
    const before = await prisma.trade.findUnique({ where: { id: f.id } });
    if (!before) { console.log(`  ✗ ${f.label}: trade ${f.id} not found`); continue; }
    console.log(`  ${f.label}`);
    console.log(`    before: date=${before.tradeDate.toISOString().slice(0,10)} rate=${Number(before.rate)} comm=${Number(before.commission)} gross=${Number(before.grossAmount)}`);
    console.log(`    after : ${JSON.stringify(Object.fromEntries(Object.entries(f.data).map(([k,v]) => [k, v instanceof Date ? v.toISOString().slice(0,10) : v])))}`);
    if (APPLY) {
      const updated = await prisma.trade.update({ where: { id: f.id }, data: f.data as any });
      await repostVoucher(updated);
      console.log(`    ✓ trade updated + voucher re-posted`);
    }
  }
  console.log(APPLY ? "\nDone." : "\nDry-run — re-run with --apply to write.");
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
