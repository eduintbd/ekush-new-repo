/* eslint-disable */
// One-shot seed for the tax_rates table. Idempotent — checks for an
// existing row per (jurisdiction, rateType) before inserting.
//
// Run after the tax_rates table is created (phase 1 of the Tax
// Provision module) to populate the BD statutory defaults from the
// 2025-26 finance act. The IS/BS already falls back to the same
// numbers via DEFAULT_RATES in src/lib/tax-rates.ts when no row
// exists, so this seed is optional for correctness but recommended
// for the audit trail (the Tax Provision card surfaces effective-from
// dates + statutory references on each rate row).
//
// Run: npx tsx scripts/seed-tax-rates.ts

import { config } from "dotenv";
config({ path: ".env" });

import { PrismaClient } from "@/generated/prisma";

const prisma = new PrismaClient();

type SeedRow = {
  jurisdiction: string;
  rateType: "CAPITAL_GAIN" | "DIVIDEND" | "INTEREST" | "DEFERRED" | "MGMT_FEE";
  value: number;
  effectiveFrom: string;
  note: string;
};

const ROWS: SeedRow[] = [
  {
    jurisdiction: "BD",
    rateType: "CAPITAL_GAIN",
    value: 0.15,
    effectiveFrom: "2024-07-01",
    note: "BD Finance Act 2024 §53BB — capital gains on listed shares held > 1 yr.",
  },
  {
    jurisdiction: "BD",
    rateType: "DIVIDEND",
    value: 0.20,
    effectiveFrom: "2024-07-01",
    note: "BD Finance Act 2024 §54 — withholding on dividend income.",
  },
  {
    jurisdiction: "BD",
    rateType: "INTEREST",
    value: 0.10,
    effectiveFrom: "2024-07-01",
    note: "BD Finance Act 2024 §49 — withholding on SND/FDR interest.",
  },
  {
    jurisdiction: "BD",
    rateType: "DEFERRED",
    value: 0.15,
    effectiveFrom: "2024-07-01",
    note: "Deferred-tax rate on unrealised fair-value gains/losses; tracks the capital-gain rate.",
  },
];

async function main() {
  for (const r of ROWS) {
    const existing = await prisma.taxRate.findFirst({
      where: {
        jurisdiction: r.jurisdiction,
        rateType: r.rateType,
        effectiveFrom: new Date(r.effectiveFrom),
      },
    });
    if (existing) {
      console.log(`✓ ${r.jurisdiction}/${r.rateType} @ ${r.effectiveFrom} — already present (id ${existing.id.slice(0, 8)}…)`);
      continue;
    }
    const created = await prisma.taxRate.create({
      data: {
        jurisdiction: r.jurisdiction,
        rateType: r.rateType,
        value: r.value,
        effectiveFrom: new Date(r.effectiveFrom),
        note: r.note,
      },
    });
    console.log(`+ ${r.jurisdiction}/${r.rateType} @ ${r.effectiveFrom} = ${(r.value * 100).toFixed(2)}%  (id ${created.id.slice(0, 8)}…)`);
  }
  console.log("\nDone. Verify with: SELECT * FROM xsystem.tax_rates ORDER BY rate_type, effective_from;");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
