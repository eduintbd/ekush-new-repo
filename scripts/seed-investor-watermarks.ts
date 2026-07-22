// Seed the combined-fund upfront watermark, per (agent, investor), from
// history. Writes ONLY watermark rows — never a CommissionRun.
//
//   npx tsx scripts/seed-investor-watermarks.ts                       # dry run, through today
//   npx tsx scripts/seed-investor-watermarks.ts --through 2026-06-30  # dry run, through a date
//   npx tsx scripts/seed-investor-watermarks.ts --through 2026-06-30 --apply
//
// THE --through DATE IS A MONEY DECISION. Seeding each investor's watermark to
// their all-time combined peak means past business earns nothing on the first
// live run — that is what "no back-payment" means, and it forfeits the pending
// upfront that has accrued (large: BI0000 was ~178k under the old model).
// Seeding through an earlier contract-effective date lets the first run pay the
// delta from then on. Get the date signed off before --apply.
//
// Dry run is the default. --apply must be given the --through date explicitly.

import { readFileSync } from "fs";
for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, "");
}

import { prisma } from "@/lib/prisma";
import { categoryForFund, type FundCode } from "@/lib/ekush-web/types";
import {
  fetchAgentInvestorTxns,
  computeCombinedWatermarkUpfront,
  type RateResolver,
} from "@/lib/upfront-watermark";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const throughStr = arg("--through");
  if (apply && !throughStr) {
    console.error("--apply requires an explicit --through <YYYY-MM-DD>. Refusing to bake in an implicit 'today'.");
    process.exit(1);
  }
  const through = throughStr ? new Date(`${throughStr}T23:59:59.999Z`) : new Date();
  if (Number.isNaN(through.getTime())) {
    console.error(`Invalid --through date: ${throughStr}`);
    process.exit(1);
  }

  console.log(`${apply ? "APPLYING" : "DRY RUN"} — seeding watermarks as at ${through.toISOString().slice(0, 10)}\n`);

  const agents = await prisma.sellingAgent.findMany({
    where: { status: "approved" },
    include: { terms: true },
    orderBy: { code: "asc" },
  });

  let grandWm = 0;
  let grandForfeit = 0;

  for (const a of agents) {
    const rateFor: RateResolver = (fundCode) => {
      const category = categoryForFund(fundCode as FundCode);
      const t = a.terms
        .filter((x) => x.fundCategory === category && x.effectiveFrom <= through && (x.effectiveTo === null || x.effectiveTo > through))
        .sort((x, y) => +y.effectiveFrom - +x.effectiveFrom)[0];
      return t ? { rate: Number(t.upfrontPct), category } : null;
    };

    const { byInvestor } = await fetchAgentInvestorTxns(prisma, a.id, through);
    if (byInvestor.size === 0) continue;

    console.log(`AGENT ${a.code} — ${a.fullName}`);
    let agentWm = 0;
    let agentForfeit = 0;

    for (const [investorCode, txns] of byInvestor) {
      // Seed FROM ZERO to find the true all-time peak; the "forfeit" is what a
      // run from zero would have paid — i.e. what seeding declines to pay.
      const res = computeCombinedWatermarkUpfront(txns, 0, rateFor);
      agentWm += res.newWatermark;
      agentForfeit += res.upfront;

      console.log(
        `  ${investorCode.padEnd(9)} watermark ${res.newWatermark.toFixed(2).padStart(14)}  ` +
          `net now ${res.netPrincipal.toFixed(2).padStart(14)}  CIP excl ${res.cipOffset.toFixed(2).padStart(10)}  ` +
          `(${res.txCount} mv, ${res.slices.length} fund)${res.unratedFunds.length ? `  [no term: ${res.unratedFunds.join(",")}]` : ""}`,
      );

      if (apply) {
        await prisma.agentInvestorWatermark.upsert({
          where: { agentId_investorCode: { agentId: a.id, investorCode } },
          create: {
            agentId: a.id,
            investorCode,
            watermark: res.newWatermark,
            netPrincipal: res.netPrincipal,
            cipOffset: res.cipOffset,
            throughDate: through,
          },
          update: {
            watermark: res.newWatermark,
            netPrincipal: res.netPrincipal,
            cipOffset: res.cipOffset,
            throughDate: through,
          },
        });
      }
    }

    console.log(
      `  → seed total watermark ${agentWm.toFixed(2)};  upfront FORFEITED by seeding through ${through.toISOString().slice(0, 10)}: ${agentForfeit.toFixed(2)}\n`,
    );
    grandWm += agentWm;
    grandForfeit += agentForfeit;
  }

  console.log(`ALL AGENTS — seed watermark ${grandWm.toFixed(2)};  total forfeited ${grandForfeit.toFixed(2)}`);
  if (!apply) console.log("\nDry run — nothing written. Re-run with --apply and the agreed --through date once signed off.");
}

main().finally(() => prisma.$disconnect());
