// Idempotent seed runner. Safe to re-run — uses upsert keyed on
// chart_of_accounts.name (which is the FK target for journals).
import { PrismaClient } from "../../src/generated/prisma";
import { CHART_OF_ACCOUNTS_SEED } from "./chart-of-accounts";

const prisma = new PrismaClient();

async function main() {
  console.log(`Seeding chart_of_accounts (${CHART_OF_ACCOUNTS_SEED.length} rows)…`);

  for (const acc of CHART_OF_ACCOUNTS_SEED) {
    await prisma.chartOfAccount.upsert({
      where: { name: acc.name },
      create: {
        sl: acc.sl,
        name: acc.name,
        normalBalance: acc.normalBalance,
      },
      update: {
        sl: acc.sl,
        normalBalance: acc.normalBalance,
      },
    });
  }

  // Bangladesh fiscal year: July 1 → June 30.
  const fyLabel = "FY2025-26";
  await prisma.fiscalYear.upsert({
    where: { label: fyLabel },
    create: {
      label: fyLabel,
      startsOn: new Date("2025-07-01"),
      endsOn: new Date("2026-06-30"),
    },
    update: {},
  });
  console.log(`Ensured fiscal year ${fyLabel}.`);

  const total = await prisma.chartOfAccount.count();
  console.log(`Done. chart_of_accounts now has ${total} rows.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
