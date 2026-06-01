/* eslint-disable */
// Post the FY 2024-25 year-end closing entries to the database.
// Replays the same logic as preview-fy24-25-close.ts and writes two
// Journal vouchers dated 2025-06-30:
//
//   JV/24-25/CLOSE-1 — BS true-up entries (post-close audit adjustments)
//   JV/24-25/CLOSE-2 — P&L closure to Retained Earning
//
// After these post, the closing TB of FY24-25 == OB of FY25-26 exactly.
//
// Idempotency: wipes any existing JV/24-25/CLOSE-1 + CLOSE-2 vouchers
// before re-posting, so it's safe to re-run.
//
// Usage: npx tsx scripts/post-fy24-25-close.ts            (commit)
//        npx tsx scripts/post-fy24-25-close.ts --dry-run  (rollback)

import { config } from "dotenv";
config({ path: ".env" });
import { PrismaClient, Prisma } from "@/generated/prisma";
import { randomUUID } from "node:crypto";

const prisma = new PrismaClient();

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

type Leg = { account: string; debit: number; credit: number; note?: string };

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  console.log(`Mode: ${dryRun ? "DRY-RUN (will roll back)" : "COMMIT"}`);

  const fy24 = await prisma.fiscalYear.findFirst({ where: { label: "FY2024-25" } });
  const fy25 = await prisma.fiscalYear.findFirst({ where: { label: "FY2025-26" } });
  if (!fy24 || !fy25) {
    console.error("Need both FY2024-25 and FY2025-26");
    process.exit(1);
  }

  // Skip if closing entries already exist and aren't being re-run
  // (we'll wipe and re-post inside the transaction anyway).

  // 1. Compute closing TB of FY24-25 (excluding any prior CLOSE-1/2 posts)
  const lines24 = await prisma.journal.findMany({
    where: {
      fiscalYearId: fy24.id,
      NOT: { voucherNo: { in: ["JV/24-25/CLOSE-1", "JV/24-25/CLOSE-2"] } },
    },
    select: { accountName: true, debit: true, credit: true },
  });
  const closing24 = new Map<string, number>();
  for (const l of lines24) {
    closing24.set(
      l.accountName,
      (closing24.get(l.accountName) ?? 0) + Number(l.debit) - Number(l.credit),
    );
  }
  for (const k of closing24.keys()) closing24.set(k, r2(closing24.get(k)!));

  // 2. Compute OB of FY25-26
  const ob25rows = await prisma.journal.findMany({
    where: { fiscalYearId: fy25.id, txnType: "OB" },
    select: { accountName: true, debit: true, credit: true },
  });
  const opening25 = new Map<string, number>();
  for (const l of ob25rows) {
    opening25.set(
      l.accountName,
      (opening25.get(l.accountName) ?? 0) + Number(l.debit) - Number(l.credit),
    );
  }
  for (const k of opening25.keys()) opening25.set(k, r2(opening25.get(k)!));

  // 3. Classify each account: any account with non-zero OB FY25-26 is BS.
  const isPL = (acc: string): boolean => {
    if (acc === "Retained Earning") return false;
    return Math.abs(opening25.get(acc) ?? 0) < 0.01;
  };

  // 4. Build the two journals
  const allAccs = new Set<string>([...closing24.keys(), ...opening25.keys()]);
  const bsLegs: Leg[] = [];
  const plLegs: Leg[] = [];
  let bsRePlug = 0; // jv1NetToRe = jv1ReDebit - jv1ReCredit
  let plRePlug = 0; // jv2NetToRe

  for (const acc of allAccs) {
    const c = closing24.get(acc) ?? 0;
    const o = opening25.get(acc) ?? 0;
    const delta = r2(o - c);
    if (Math.abs(delta) < 0.01) continue;
    if (acc === "Retained Earning") continue; // handled via the plug

    if (isPL(acc)) {
      if (c > 0) {
        plLegs.push({ account: acc, debit: 0, credit: c, note: "P&L close" });
        plRePlug += c;
      } else if (c < 0) {
        plLegs.push({ account: acc, debit: -c, credit: 0, note: "P&L close" });
        plRePlug -= -c;
      }
    } else {
      if (delta > 0) {
        bsLegs.push({ account: acc, debit: delta, credit: 0, note: "BS true-up" });
        bsRePlug -= delta;
      } else {
        bsLegs.push({ account: acc, debit: 0, credit: -delta, note: "BS true-up" });
        bsRePlug -= delta; // delta is negative → += positive
      }
    }
  }
  bsRePlug = r2(bsRePlug);
  plRePlug = r2(plRePlug);

  // bsRePlug as defined: positive means Dr RE, negative means Cr RE
  if (Math.abs(bsRePlug) > 0.01) {
    if (bsRePlug > 0)
      bsLegs.push({ account: "Retained Earning", debit: bsRePlug, credit: 0, note: "RE plug" });
    else
      bsLegs.push({ account: "Retained Earning", debit: 0, credit: -bsRePlug, note: "RE plug" });
  }
  if (Math.abs(plRePlug) > 0.01) {
    if (plRePlug > 0)
      plLegs.push({ account: "Retained Earning", debit: plRePlug, credit: 0, note: "Net loss → RE" });
    else
      plLegs.push({ account: "Retained Earning", debit: 0, credit: -plRePlug, note: "Net profit → RE" });
  }

  // Pre-flight: balance check
  const bsD = r2(bsLegs.reduce((s, l) => s + l.debit, 0));
  const bsC = r2(bsLegs.reduce((s, l) => s + l.credit, 0));
  const plD = r2(plLegs.reduce((s, l) => s + l.debit, 0));
  const plC = r2(plLegs.reduce((s, l) => s + l.credit, 0));
  console.log(`\nJV/24-25/CLOSE-1 (BS):  ${bsLegs.length} lines  Σ(D)=${bsD}  Σ(C)=${bsC}  ${Math.abs(bsD - bsC) < 0.01 ? "✓" : "✗"}`);
  console.log(`JV/24-25/CLOSE-2 (P&L): ${plLegs.length} lines  Σ(D)=${plD}  Σ(C)=${plC}  ${Math.abs(plD - plC) < 0.01 ? "✓" : "✗"}`);
  if (Math.abs(bsD - bsC) >= 0.01 || Math.abs(plD - plC) >= 0.01) {
    console.error("ABORT: closing entries unbalanced");
    process.exit(1);
  }

  // Find admin profile
  const admin = await prisma.profile.findFirst({
    where: { role: "admin", isActive: true },
    orderBy: { createdAt: "asc" },
  });
  if (!admin) {
    console.error("ABORT: no admin profile");
    process.exit(1);
  }
  console.log(`createdBy: ${admin.email}`);

  const closingDate = new Date("2025-06-30T00:00:00.000Z");

  await prisma
    .$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL xsystem.actor_uuid = '${admin.id}'`);

        // Wipe any prior closing posts
        const del = await tx.journal.deleteMany({
          where: { voucherNo: { in: ["JV/24-25/CLOSE-1", "JV/24-25/CLOSE-2"] } },
        });
        console.log(`• Deleted ${del.count} prior closing-entry rows`);

        // Post CLOSE-1
        const batch1 = randomUUID();
        for (const leg of bsLegs) {
          await tx.journal.create({
            data: {
              entryDate: closingDate,
              description: "Year-end closing — BS true-up",
              txnType: "JV",
              voucherNo: "JV/24-25/CLOSE-1",
              accountName: leg.account,
              debit: leg.debit,
              credit: leg.credit,
              fiscalYearId: fy24.id,
              batchId: batch1,
              createdBy: admin.id,
            },
          });
        }
        console.log(`✓ Posted JV/24-25/CLOSE-1: ${bsLegs.length} lines`);

        // Post CLOSE-2
        const batch2 = randomUUID();
        for (const leg of plLegs) {
          await tx.journal.create({
            data: {
              entryDate: closingDate,
              description: "Year-end closing — P&L → Retained Earning",
              txnType: "JV",
              voucherNo: "JV/24-25/CLOSE-2",
              accountName: leg.account,
              debit: leg.debit,
              credit: leg.credit,
              fiscalYearId: fy24.id,
              batchId: batch2,
              createdBy: admin.id,
            },
          });
        }
        console.log(`✓ Posted JV/24-25/CLOSE-2: ${plLegs.length} lines`);

        // Final verify: closing FY24-25 = opening FY25-26 for every account
        const finalLines = await tx.journal.findMany({
          where: { fiscalYearId: fy24.id },
          select: { accountName: true, debit: true, credit: true },
        });
        const finalClosing = new Map<string, number>();
        for (const l of finalLines) {
          finalClosing.set(
            l.accountName,
            (finalClosing.get(l.accountName) ?? 0) + Number(l.debit) - Number(l.credit),
          );
        }
        for (const k of finalClosing.keys()) finalClosing.set(k, r2(finalClosing.get(k)!));
        let mismatches = 0;
        const allFinalAccs = new Set([...finalClosing.keys(), ...opening25.keys()]);
        for (const acc of allFinalAccs) {
          const fc = finalClosing.get(acc) ?? 0;
          const op = opening25.get(acc) ?? 0;
          if (Math.abs(fc - op) >= 0.01) {
            mismatches++;
            if (mismatches <= 5)
              console.log(`  MISMATCH: ${acc}  closing=${fc}  ob25=${op}`);
          }
        }
        if (mismatches > 0) {
          throw new Error(`Post-close verification failed: ${mismatches} mismatches`);
        }
        console.log(`✓ Verification: all ${allFinalAccs.size} accounts reconcile (closing FY24-25 == OB FY25-26)`);

        if (dryRun) throw new Error("__DRY_RUN_ROLLBACK__");
      },
      { maxWait: 30_000, timeout: 120_000, isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    )
    .catch((err) => {
      if (err instanceof Error && err.message === "__DRY_RUN_ROLLBACK__") {
        console.log(`✓ Dry-run rolled back. Re-run without --dry-run to commit.`);
        return;
      }
      throw err;
    });

  if (!dryRun) console.log(`\n✓ FY 2024-25 year-end close posted.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
