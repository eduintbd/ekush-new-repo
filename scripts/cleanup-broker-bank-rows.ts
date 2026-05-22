/* eslint-disable */
// One-off cleanup: remove the 4 broker / margin-loan rows from
// bank_accounts. They were seeded into BankAccount earlier so the
// /trades/new dropdown could include them, but conceptually they
// belong on the Broker row (UCB Securities + Prime Bank Securities
// are broker subsidiaries, not banks). Now /trades/new derives those
// options from the Broker table directly.
//
// Safe because:
// - BankAccount has no incoming FKs that would break on delete.
// - The matching ChartOfAccount rows STAY — journals still reference
//   them by name.
// - Existing Trade.bankAccount string values still point at valid CoA
//   names; nothing on the GL side moves.

import { config } from "dotenv";
config({ path: ".env" });

import { PrismaClient } from "@/generated/prisma";

const prisma = new PrismaClient();

const NAMES_TO_REMOVE = [
  "UCB BO (1205590068173895)",
  "Prime Bank Securities Limited",
  "Margin Loan From UCB",
  "Margin Loan From Prime Bank Securities",
];

async function main() {
  const existing = await prisma.bankAccount.findMany({
    where: { accountName: { in: NAMES_TO_REMOVE } },
    select: { accountName: true },
  });
  if (existing.length === 0) {
    console.log("No broker-related rows found in bank_accounts — already cleaned.");
    return;
  }

  console.log(`Removing ${existing.length} broker-related row(s) from bank_accounts:`);
  for (const r of existing) console.log(`  - ${r.accountName}`);

  const result = await prisma.bankAccount.deleteMany({
    where: { accountName: { in: NAMES_TO_REMOVE } },
  });
  console.log(`\nDeleted ${result.count} rows. (chart_of_accounts rows unchanged.)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
