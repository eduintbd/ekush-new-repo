// Inspect the portal's public.* schema to find investor-related tables
// and the field that links investors to selling-agent codes.

import { PrismaClient } from "../src/generated/prisma";

const p = new PrismaClient();

async function main() {
  // 1. List every public.* table whose name suggests it's investor-related
  const tables = await p.$queryRawUnsafe<Array<{ table_name: string }>>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public'
       AND (table_name ILIKE '%investor%'
            OR table_name ILIKE '%subscriber%'
            OR table_name ILIKE '%subscription%'
            OR table_name ILIKE '%holding%'
            OR table_name ILIKE '%client%'
            OR table_name ILIKE '%customer%'
            OR table_name ILIKE '%agent%'
            OR table_name ILIKE '%sales%'
            OR table_name ILIKE '%nav%'
            OR table_name ILIKE '%unit%')
     ORDER BY table_name`,
  );
  console.log("=== Investor-related tables in public.* ===");
  console.table(tables);

  // 2. For each, show columns + row count + a sample row
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
      console.log("Sample rows:");
      console.dir(sample, { depth: null });
    }
  }

  await p.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
