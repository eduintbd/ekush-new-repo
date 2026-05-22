// Idempotent seed runner. Safe to re-run — uses upsert keyed on
// chart_of_accounts.name (which is the FK target for journals).
import { PrismaClient } from "../../src/generated/prisma";
import { CHART_OF_ACCOUNTS_SEED } from "./chart-of-accounts";
import { INSTRUMENTS_SEED } from "./instruments";

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

  // Validate every instrument's investmentAccount exists as a CoA row,
  // otherwise the auto-journal generator will fail at runtime on the
  // investment leg. Fail-fast at seed time gives a clearer error.
  const coaNames = new Set(
    (await prisma.chartOfAccount.findMany({ select: { name: true } })).map((a) => a.name),
  );
  for (const inst of INSTRUMENTS_SEED) {
    if (!coaNames.has(inst.investmentAccount)) {
      throw new Error(
        `Instrument ${inst.code}: investmentAccount "${inst.investmentAccount}" is not in chart_of_accounts. ` +
          `Add it to chart-of-accounts.ts before seeding instruments.`,
      );
    }
  }

  console.log(`Seeding instruments (${INSTRUMENTS_SEED.length} rows)…`);
  for (const inst of INSTRUMENTS_SEED) {
    await prisma.instrument.upsert({
      where: { code: inst.code },
      create: {
        code: inst.code,
        name: inst.name,
        category: inst.category,
        investmentAccount: inst.investmentAccount,
      },
      update: {
        name: inst.name,
        category: inst.category,
        investmentAccount: inst.investmentAccount,
      },
    });
  }

  const coaTotal = await prisma.chartOfAccount.count();
  const instTotal = await prisma.instrument.count();
  console.log(`Done. chart_of_accounts: ${coaTotal} rows, instruments: ${instTotal} rows.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
