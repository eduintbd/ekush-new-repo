import { PrismaClient } from "../src/generated/prisma";

const p = new PrismaClient();

async function main() {
  const cols = await p.$queryRawUnsafe<Array<{ column_name: string; data_type: string }>>(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'daily_fund_uploads'
     ORDER BY ordinal_position`,
  );
  console.log("=== columns ===");
  console.table(cols);

  const cnt = await p.$queryRawUnsafe<unknown[]>(
    `SELECT COUNT(*)::int AS n,
            MIN("reportDate") AS earliest,
            MAX("reportDate") AS latest,
            COUNT(DISTINCT "fundId")::int AS funds
     FROM public.daily_fund_uploads
     WHERE "uploadType" = 'FIN_STATS'`,
  );
  console.log("=== FIN_STATS summary ===");
  console.table(cnt);

  const samp = await p.$queryRawUnsafe<unknown[]>(
    `SELECT id, "fundId", "uploadType", "reportDate", "fileName", status
     FROM public.daily_fund_uploads
     WHERE "uploadType" = 'FIN_STATS'
     ORDER BY "reportDate" DESC LIMIT 5`,
  );
  console.log("=== latest 5 FIN_STATS ===");
  console.table(samp);

  const funds = await p.$queryRawUnsafe<unknown[]>(
    `SELECT id, code, name FROM public.funds ORDER BY code`,
  );
  console.log("=== funds ===");
  console.table(funds);

  await p.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
