/* eslint-disable */
// One-off: migrate journal rows on legacy 'Capital Gain' (sl 98) and
// 'Capital Gain/ loss' (sl 26) onto the new consolidated account
// 'Realised Gain/(Loss) on Investments' (sl 128, added in Phase 1).
// After migration the two legacy CoA rows are marked inactive.

import { config } from "dotenv";
config({ path: ".env" });

import { PrismaClient } from "@/generated/prisma";

const prisma = new PrismaClient();

const LEGACY = ["Capital Gain", "Capital Gain/ loss"];
const TARGET = "Realised Gain/(Loss) on Investments";

async function main() {
  // Confirm target exists
  const target = await prisma.chartOfAccount.findUnique({ where: { name: TARGET } });
  if (!target) {
    console.error(`ERROR: target account "${TARGET}" not in chart_of_accounts. Run seed first.`);
    process.exit(1);
  }

  for (const legacy of LEGACY) {
    const acc = await prisma.chartOfAccount.findUnique({ where: { name: legacy } });
    if (!acc) {
      console.log(`(no row for "${legacy}" — skipping)`);
      continue;
    }
    const journalCount = await prisma.journal.count({ where: { accountName: legacy } });
    console.log(`"${legacy}": ${journalCount} journal row(s) to migrate`);

    if (journalCount > 0) {
      const res = await prisma.journal.updateMany({
        where: { accountName: legacy },
        data: { accountName: TARGET },
      });
      console.log(`  → moved ${res.count} journal row(s) to "${TARGET}"`);
    }

    // Now safe to deactivate (or delete) the legacy CoA row.
    // Deactivate (not delete) so the historical voucher list still has
    // a name to point at if anything escaped the updateMany.
    await prisma.chartOfAccount.update({
      where: { name: legacy },
      data: { isActive: false },
    });
    console.log(`  → marked "${legacy}" inactive`);
  }

  // Sanity check
  const finalCount = await prisma.journal.count({ where: { accountName: { in: LEGACY } } });
  if (finalCount > 0) {
    console.error(`WARN: ${finalCount} journal row(s) still on legacy account names`);
    process.exit(1);
  }
  console.log("\nDone. All legacy Capital Gain / Capital Gain-loss journal rows migrated.");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
