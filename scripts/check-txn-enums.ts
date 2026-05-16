import { PrismaClient } from "../src/generated/prisma";

async function main() {
  const p = new PrismaClient();
  const r = await p.$queryRawUnsafe<unknown[]>(
    `SELECT direction, status, COUNT(*)::int AS n
     FROM public.transactions
     GROUP BY direction, status ORDER BY n DESC`,
  );
  console.table(r);
  await p.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
