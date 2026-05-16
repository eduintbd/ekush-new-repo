// Find portal tables holding subscription / redemption transaction history
// (the activity that feeds into fund_holdings snapshots).

import { PrismaClient } from "../src/generated/prisma";

const p = new PrismaClient();

async function main() {
  const tables = await p.$queryRawUnsafe<Array<{ table_name: string }>>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public'
       AND (table_name ILIKE '%transaction%'
            OR table_name ILIKE '%redemption%'
            OR table_name ILIKE '%redeem%'
            OR table_name ILIKE '%subscription%'
            OR table_name ILIKE '%subscribe%'
            OR table_name ILIKE '%sell%'
            OR table_name ILIKE '%sale%'
            OR table_name ILIKE '%buy%'
            OR table_name ILIKE '%purchase%'
            OR table_name ILIKE '%sip%'
            OR table_name ILIKE '%ls_%'
            OR table_name ILIKE '%trade%')
     ORDER BY table_name`,
  );
  console.log("=== Transaction-style tables ===");
  console.table(tables);

  for (const t of tables) {
    console.log(`\n--- ${t.table_name} ---`);
    const cols = await p.$queryRawUnsafe<Array<{ column_name: string; data_type: string }>>(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_schema='public' AND table_name='${t.table_name}'
       ORDER BY ordinal_position`,
    );
    console.table(cols);
    const cnt = await p.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT COUNT(*)::int AS n FROM public."${t.table_name}"`,
    );
    console.log(`Rows: ${cnt[0].n}`);
    if (cnt[0].n > 0) {
      const sample = await p.$queryRawUnsafe<unknown[]>(
        `SELECT * FROM public."${t.table_name}" LIMIT 2`,
      );
      console.log("Sample:");
      console.dir(sample, { depth: null });
    }
  }

  await p.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
