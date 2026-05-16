// Backfill voucher_no for every existing batch. Idempotent — only rows
// where voucher_no IS NULL get assigned.
//
// Numbering scheme (per FY):
//   OB/{YY-YY}/####   when every line in the batch has txn_type='OB'
//   JV/{YY-YY}/####   for everything else
// Sequence within a (prefix, fy) is ordered by min(entry_date) per batch,
// then min(created_at) as tiebreaker, ascending.

import { PrismaClient } from "../src/generated/prisma";

function fyShortLabel(label: string): string {
  // 'FY2025-26' -> '25-26'
  const m = label.match(/(\d{2})(\d{2})-(\d{2})/);
  return m ? `${m[2]}-${m[3]}` : label.replace(/^FY/, "");
}

async function main() {
  const prisma = new PrismaClient();
  const fys = await prisma.fiscalYear.findMany({ orderBy: { startsOn: "asc" } });

  for (const fy of fys) {
    const short = fyShortLabel(fy.label);
    console.log(`\n=== ${fy.label} (${short}) ===`);

    // Gather batches that still lack a voucher_no
    const batches = await prisma.$queryRawUnsafe<
      Array<{
        batch_id: string;
        txn_type: string | null;
        min_entry: Date;
        min_created: Date;
        line_count: bigint;
      }>
    >(
      `SELECT
         batch_id,
         MIN(txn_type) AS txn_type,
         MIN(entry_date) AS min_entry,
         MIN(created_at) AS min_created,
         COUNT(*) AS line_count
       FROM xsystem.journals
       WHERE fiscal_year_id = $1::uuid
         AND voucher_no IS NULL
         AND batch_id IS NOT NULL
       GROUP BY batch_id
       ORDER BY MIN(entry_date) ASC, MIN(created_at) ASC`,
      fy.id,
    );

    if (batches.length === 0) {
      console.log("  no batches to backfill.");
      continue;
    }

    // Count distinct prefixes that already exist in this FY so we continue
    // sequences rather than resetting.
    const startingMax = new Map<string, number>();
    for (const prefix of ["JV", "OB"]) {
      const r = await prisma.$queryRawUnsafe<Array<{ max_seq: string | null }>>(
        `SELECT MAX(SUBSTRING(voucher_no FROM '${prefix}/${short}/([0-9]+)$')) AS max_seq
         FROM xsystem.journals
         WHERE fiscal_year_id = $1::uuid
           AND voucher_no LIKE '${prefix}/${short}/%'`,
        fy.id,
      );
      startingMax.set(prefix, Number(r[0]?.max_seq ?? 0));
    }

    let jvCounter = startingMax.get("JV") ?? 0;
    let obCounter = startingMax.get("OB") ?? 0;
    let assigned = 0;

    for (const b of batches) {
      // Determine prefix: OB only if every line in the batch is txn_type='OB'.
      // The aggregate MIN(txn_type) above isn't strict; double-check via a
      // direct query for batches that look like OB.
      const isOB = b.txn_type === "OB" && await isAllOB(prisma, b.batch_id);
      const prefix = isOB ? "OB" : "JV";
      const seq = prefix === "OB" ? ++obCounter : ++jvCounter;
      const voucherNo = `${prefix}/${short}/${String(seq).padStart(4, "0")}`;

      await prisma.journal.updateMany({
        where: { batchId: b.batch_id, voucherNo: null },
        data: { voucherNo },
      });
      assigned++;
    }

    console.log(`  ${assigned} batches assigned voucher numbers (JV up to ${jvCounter}, OB up to ${obCounter}).`);
  }

  // Also handle any orphan rows that have no batch_id (shouldn't happen but
  // be defensive — assign each its own voucher number).
  for (const fy of fys) {
    const short = fyShortLabel(fy.label);
    const orphans = await prisma.journal.findMany({
      where: { fiscalYearId: fy.id, voucherNo: null, batchId: null },
      orderBy: [{ entryDate: "asc" }, { createdAt: "asc" }],
      select: { id: true, txnType: true },
    });
    if (orphans.length === 0) continue;
    const r = await prisma.$queryRawUnsafe<Array<{ max_seq: string | null }>>(
      `SELECT MAX(SUBSTRING(voucher_no FROM 'JV/${short}/([0-9]+)$')) AS max_seq
       FROM xsystem.journals
       WHERE fiscal_year_id = $1::uuid AND voucher_no LIKE 'JV/${short}/%'`,
      fy.id,
    );
    let n = Number(r[0]?.max_seq ?? 0);
    for (const o of orphans) {
      n++;
      await prisma.journal.update({
        where: { id: o.id },
        data: { voucherNo: `JV/${short}/${String(n).padStart(4, "0")}` },
      });
    }
    console.log(`  ${fy.label}: ${orphans.length} orphan rows numbered.`);
  }

  await prisma.$disconnect();
}

async function isAllOB(prisma: PrismaClient, batchId: string): Promise<boolean> {
  const distinct = await prisma.$queryRawUnsafe<Array<{ txn_type: string | null }>>(
    `SELECT DISTINCT txn_type FROM xsystem.journals WHERE batch_id = $1::uuid`,
    batchId,
  );
  return distinct.length === 1 && distinct[0].txn_type === "OB";
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
