/* eslint-disable */
// One-off: fix the 9 self-unbalanced FY2025-26 JV vouchers.
//
// Each is a correct transaction whose debit half and credit half were entered
// under two different voucher numbers (by the seed import). Neither balances
// alone; together each cluster nets to zero (so the TB always balanced). The
// fix re-files each misplaced leg into its partner voucher — updating only
// (batchId, voucherNo, entryDate); accountName/debit/credit are untouched, so
// there is ZERO trial-balance / balance-sheet impact. Emptying a voucher of
// all its rows makes that voucher number vanish (a harmless sequence gap).
//
// Moved lines adopt the TARGET voucher's date. Run with --apply to write;
// default is a dry-run that prints every touched voucher's before/after totals.

import { config } from "dotenv";
config({ path: ".env" });

import { PrismaClient } from "@/generated/prisma";
import { withActor } from "@/lib/prisma";

const prisma = new PrismaClient();
const ACTOR = "1eb8d643-5a27-41a8-9bb5-60b44d99dacc"; // syed@eduintbd.com (accountant)
const f = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Each move: identify ONE line by (from voucher, account, debit, credit), re-file to `to`.
const MOVES = [
  { from: "JV/25-26/0168", to: "JV/25-26/0167", account: "Management Fee Accrued", debit: 0, credit: 935848 },
  { from: "JV/25-26/0091", to: "JV/25-26/0079", account: "Petty Cash", debit: 0, credit: 6925 },
  { from: "JV/25-26/0057", to: "JV/25-26/0055", account: "Investment in Mutual Fund (S.R.F)", debit: 0, credit: 127966.24 },
  { from: "JV/25-26/0057", to: "JV/25-26/0055", account: "Realised Gain/(Loss) on Investments", debit: 0, credit: 12033.76 },
  { from: "JV/25-26/0050", to: "JV/25-26/0046", account: "Midland (A/C No. 00011060000128)", debit: 0, credit: 500000 },
  { from: "JV/25-26/0049", to: "JV/25-26/0050", account: "Realised Gain/(Loss) on Investments", debit: 0, credit: 31837.77 },
];

// Every voucher touched (sources + targets) — for the before/after balance check.
const TOUCHED = ["JV/25-26/0046", "JV/25-26/0049", "JV/25-26/0050", "JV/25-26/0055", "JV/25-26/0057", "JV/25-26/0079", "JV/25-26/0091", "JV/25-26/0167", "JV/25-26/0168"];

async function totals(voucherNo: string) {
  const ls = await prisma.journal.findMany({ where: { voucherNo }, select: { debit: true, credit: true } });
  const dr = ls.reduce((s, l) => s + Number(l.debit), 0);
  const cr = ls.reduce((s, l) => s + Number(l.credit), 0);
  return { n: ls.length, dr, cr, off: dr - cr };
}

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(`Fix split vouchers — ${apply ? "APPLY" : "DRY-RUN"}\n`);

  // Resolve each move to a concrete journal row id + target batch/date.
  const planned: { id: string; account: string; from: string; to: string; toBatch: string; toDate: Date }[] = [];
  for (const m of MOVES) {
    const rows = await prisma.journal.findMany({
      where: { voucherNo: m.from, accountName: m.account, debit: m.debit, credit: m.credit },
      select: { id: true },
    });
    if (rows.length !== 1) throw new Error(`Move ${m.from}→${m.to} "${m.account}" ${m.credit}: expected exactly 1 matching row, found ${rows.length} — aborting.`);
    const tgt = await prisma.journal.findFirst({ where: { voucherNo: m.to }, select: { batchId: true, entryDate: true } });
    if (!tgt?.batchId) throw new Error(`Target voucher ${m.to} not found — aborting.`);
    planned.push({ id: rows[0].id, account: m.account, from: m.from, to: m.to, toBatch: tgt.batchId, toDate: tgt.entryDate });
    console.log(`  move ${m.account.padEnd(38)} Cr ${f(m.credit).padStart(12)}  ${m.from} → ${m.to} (${tgt.entryDate.toISOString().slice(0, 10)})`);
  }

  console.log(`\nBEFORE:`);
  for (const v of TOUCHED) { const t = await totals(v); console.log(`  ${v}  Dr ${f(t.dr).padStart(13)}  Cr ${f(t.cr).padStart(13)}  off ${f(t.off)}`); }

  if (!apply) {
    console.log(`\nDry-run only. Re-run with --apply to re-file the 6 lines.`);
    return;
  }

  await withActor(ACTOR, async (tx) => {
    for (const m of planned) {
      await tx.journal.update({ where: { id: m.id }, data: { batchId: m.toBatch, voucherNo: m.to, entryDate: m.toDate } });
    }
  });

  console.log(`\nAFTER:`);
  let allBalanced = true;
  for (const v of TOUCHED) {
    const t = await totals(v);
    const ok = t.n === 0 || Math.abs(t.off) < 0.005;
    if (!ok) allBalanced = false;
    console.log(`  ${v}  Dr ${f(t.dr).padStart(13)}  Cr ${f(t.cr).padStart(13)}  off ${f(t.off)}  ${t.n === 0 ? "(emptied — gone)" : ok ? "✓" : "✗ STILL OFF"}`);
  }
  console.log(allBalanced ? `\nAll touched vouchers balance. ✓` : `\n*** SOME VOUCHERS STILL OFF — investigate ***`);
}

main().catch((e) => { console.error(e?.message ?? e); process.exit(1); }).finally(() => prisma.$disconnect());
