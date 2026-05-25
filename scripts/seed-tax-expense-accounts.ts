/* eslint-disable */
// One-off seed for the two new tax-expense CoA rows added in Phase 3
// of the Tax Provision module. Idempotent — checks for the row by
// `name` (unique) before inserting.
//
// Run: npx tsx scripts/seed-tax-expense-accounts.ts

import { config } from "dotenv";
config({ path: ".env" });

import { PrismaClient } from "@/generated/prisma";

const prisma = new PrismaClient();

const ROWS = [
  {
    sl: 132,
    name: "Income Tax Expense",
    normalBalance: "DEBIT" as const,
    note: "P&L leg of the current-tax accrual (Phase 3 Tax Provision).",
  },
  {
    sl: 133,
    name: "Deferred Tax Expense",
    normalBalance: "DEBIT" as const,
    note: "OCI leg of the deferred-tax accrual (Phase 3 Tax Provision).",
  },
];

async function main() {
  for (const r of ROWS) {
    const existing = await prisma.chartOfAccount.findUnique({ where: { name: r.name } });
    if (existing) {
      console.log(`✓ "${r.name}" already present (sl ${existing.sl}, ${existing.normalBalance})`);
      continue;
    }
    await prisma.chartOfAccount.create({
      data: {
        sl: r.sl,
        name: r.name,
        normalBalance: r.normalBalance,
      },
    });
    console.log(`+ "${r.name}" sl ${r.sl} ${r.normalBalance} — ${r.note}`);
  }
  console.log("\nDone.");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
