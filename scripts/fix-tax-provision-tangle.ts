/* eslint-disable */
// One-off: correct the FY2025-26 tax-provision re-post tangle (TX/25-26/0001-0003).
//
// Those three vouchers left both tax-expense accounts net-CREDIT:
//   Income Tax Expense   net -741,066.56  (should be +1,304,134.20 — engine canonical)
//   Deferred Tax Expense net -1,552,719.00 (should be 0 — accountant decision)
//
// Post ONE balanced correcting JV that moves each account to its target:
//   Dr Income Tax Expense        2,045,200.76   (−741,066.56 → +1,304,134.20)
//     Cr Provision for income tax 2,045,200.76
//   Dr Deferred Tax Expense      1,552,719.00   (−1,552,719.00 → 0)
//     Cr Deferred Tax             1,552,719.00
//
// Posted as a plain JV (non-TX) so the current-tax side stays idempotent with
// the tax engine (its Cr to Provision is then counted as period accrual).
// Run with --apply to write; default is dry-run.

import { config } from "dotenv";
config({ path: ".env" });

import { PrismaClient } from "@/generated/prisma";
import { withActor } from "@/lib/prisma";
import { allocateVoucherNo } from "@/lib/voucher";

const prisma = new PrismaClient();
const ACTOR = "1eb8d643-5a27-41a8-9bb5-60b44d99dacc"; // syed@eduintbd.com (accountant)

const CURRENT_FIX = 2045200.76; // Dr Income Tax Expense / Cr Provision for income tax
const DEFERRED_FIX = 1552719.0; // Dr Deferred Tax Expense / Cr Deferred Tax

async function main() {
  const apply = process.argv.includes("--apply");
  const fy = await prisma.fiscalYear.findFirst({ where: { isClosed: false }, orderBy: { startsOn: "desc" } });
  if (!fy) throw new Error("No open fiscal year");

  const desc = "Correct TX/25-26/0001-0003 re-post tangle: current tax → 1,304,134.20, deferred tax → 0";
  const entryDate = new Date("2026-06-30T00:00:00Z"); // FY-end, where the TX tangle sits

  const lines = [
    { accountName: "Income Tax Expense", debit: CURRENT_FIX, credit: 0 },
    { accountName: "Provision for income tax", debit: 0, credit: CURRENT_FIX },
    { accountName: "Deferred Tax Expense", debit: DEFERRED_FIX, credit: 0 },
    { accountName: "Deferred Tax", debit: 0, credit: DEFERRED_FIX },
  ];
  const totDr = lines.reduce((s, l) => s + l.debit, 0);
  const totCr = lines.reduce((s, l) => s + l.credit, 0);
  console.log(`FY ${fy.label} — correcting JV (${apply ? "APPLY" : "DRY-RUN"})`);
  for (const l of lines) console.log(`  ${l.accountName.padEnd(28)} Dr ${l.debit.toFixed(2).padStart(14)}  Cr ${l.credit.toFixed(2).padStart(14)}`);
  console.log(`  TOTAL Dr ${totDr.toFixed(2)}  Cr ${totCr.toFixed(2)}  (balanced: ${Math.abs(totDr - totCr) < 0.005})`);
  if (Math.abs(totDr - totCr) >= 0.005) throw new Error("Unbalanced — aborting");

  if (!apply) {
    console.log("\nDry-run only. Re-run with --apply to post.");
    return;
  }

  await withActor(ACTOR, async (tx) => {
    const voucherNo = await allocateVoucherNo(tx, fy.id, fy.label, "JV");
    const batchId = (await tx.$queryRawUnsafe<Array<{ id: string }>>(`SELECT gen_random_uuid() AS id`))[0].id;
    await tx.journal.createMany({
      data: lines.map((l) => ({
        entryDate,
        description: desc,
        txnType: "JV",
        voucherNo,
        accountName: l.accountName,
        debit: l.debit,
        credit: l.credit,
        fiscalYearId: fy.id,
        batchId,
        createdBy: ACTOR,
      })),
    });
    console.log(`\nPosted ${voucherNo} (batch ${batchId}).`);
  });
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
