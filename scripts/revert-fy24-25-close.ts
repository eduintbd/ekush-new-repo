// Reverse the year-end closing entries posted to FY24-25.
//
// Why: the JV/24-25/CLOSE-2 (P&L closure) zeros out every income and
// expense account in the journal, which breaks the side-by-side
// Income Statement comparison — the IS sums period activity and
// would see all P&L accounts net to zero.
//
// JV/24-25/CLOSE-1 (BS true-up) goes too because its Retained-Earning
// plug only balances if CLOSE-2 also posts. Without CLOSE-2, the JV-1
// plug overstates RE by 1.81 lakh.
//
// After this revert, FY24-25 contains only the imported workbook data
// (OB + 133 daily JVs). Closing TB will NOT equal FY25-26 OB exactly
// — the difference represents off-workbook year-end audit adjustments
// that pre-date this import. That's an acceptable historical gap; the
// IS / BS / CE / CF comparison feature works either way.
//
// Usage: npx tsx scripts/revert-fy24-25-close.ts            (commit)
//        npx tsx scripts/revert-fy24-25-close.ts --dry-run  (preview)

import { config } from "dotenv";
config({ path: ".env" });
import { PrismaClient, Prisma } from "@/generated/prisma";

const prisma = new PrismaClient();

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  console.log(`Mode: ${dryRun ? "DRY-RUN" : "COMMIT"}`);

  const admin = await prisma.profile.findFirst({
    where: { role: "admin", isActive: true },
    orderBy: { createdAt: "asc" },
  });
  if (!admin) {
    console.error("No admin profile found");
    process.exit(1);
  }

  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL xsystem.actor_uuid = '${admin.id}'`);

    const before = await tx.journal.count({
      where: { voucherNo: { in: ["JV/24-25/CLOSE-1", "JV/24-25/CLOSE-2"] } },
    });
    console.log(`Rows to delete: ${before}`);

    if (dryRun) {
      console.log(`(dry-run — not deleting)`);
      return;
    }

    const del = await tx.journal.deleteMany({
      where: { voucherNo: { in: ["JV/24-25/CLOSE-1", "JV/24-25/CLOSE-2"] } },
    });
    console.log(`✓ Deleted ${del.count} closing-entry rows`);
  });

  // Verify final state
  const fy24 = await prisma.fiscalYear.findFirst({ where: { label: "FY2024-25" } });
  if (!fy24) return;
  const sum = await prisma.journal.aggregate({
    where: { fiscalYearId: fy24.id },
    _sum: { debit: true, credit: true },
    _count: true,
  });
  console.log(`\nFY2024-25 state after revert:`);
  console.log(`  rows: ${sum._count}`);
  console.log(`  Σ(D) = ${Number(sum._sum.debit ?? 0).toFixed(2)}`);
  console.log(`  Σ(C) = ${Number(sum._sum.credit ?? 0).toFixed(2)}`);
  console.log(`  diff = ${(Number(sum._sum.debit ?? 0) - Number(sum._sum.credit ?? 0)).toFixed(2)}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
