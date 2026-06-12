/* eslint-disable */
// One-off baseline: set each approved agent's per-fund upfront watermark to
// the ALL-TIME PEAK of its net invested principal (Σ BUY−SELL cash),
// reconstructed from the actual deposit history. This treats upfront already
// given on past deposits as paid, so the going-forward monthly run pays only
// NEW money above the peak. No CommissionRun rows are created.
//
//   npx tsx scripts/seed-watermarks.ts          # dry-run (preview, no writes)
//   npx tsx scripts/seed-watermarks.ts --apply  # upsert the watermark rows
//
// Idempotent: re-running upserts the same peak. Direct-subscription investors
// are excluded (clause 6.5) via fetchAgentFundTxns.

import { config } from "dotenv";
config({ path: ".env" });

import { PrismaClient } from "@/generated/prisma";
import { categoryForFund } from "@/lib/ekush-web/types";
import { fetchAgentFundTxns, computeWatermarkUpfront } from "@/lib/upfront-watermark";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");
const fmt = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function upfrontPctFor(
  terms: { fundCategory: string; upfrontPct: unknown; effectiveFrom: Date; effectiveTo: Date | null }[],
  fund: string,
  asOf: Date,
): number {
  const cat = categoryForFund(fund as never);
  const active = terms
    .filter((t) => t.fundCategory === cat && t.effectiveFrom <= asOf && (t.effectiveTo === null || t.effectiveTo > asOf))
    .sort((a, b) => +b.effectiveFrom - +a.effectiveFrom);
  return active[0] ? Number(active[0].upfrontPct) : 0;
}

async function main() {
  const today = new Date();
  console.log(`Baseline watermarks — mode: ${APPLY ? "APPLY (writes)" : "DRY-RUN (no writes)"} · as of ${today.toISOString().slice(0, 10)}\n`);

  const agents = await prisma.sellingAgent.findMany({
    where: { status: "approved" },
    include: { terms: true, investors: true },
  });

  let written = 0;
  for (const agent of agents) {
    console.log(`AGENT ${agent.code} — ${agent.fullName}`);

    // Audit ledger: each linked investor's recorded deposit date + initial gross.
    const links = [...agent.investors].sort((a, b) => a.fundCode.localeCompare(b.fundCode) || +a.sourcedOn - +b.sourcedOn);
    for (const l of links) {
      const tag = l.isDirectSubscription ? " [DIRECT — excluded]" : "";
      console.log(`   • ${l.fundCode} ${l.investorCode}: deposited ${l.sourcedOn.toISOString().slice(0, 10)} · initial ${fmt(Number(l.initialGrossAmount))}${tag}`);
    }

    const byFund = await fetchAgentFundTxns(prisma, agent.id, today);
    if (byFund.size === 0) {
      console.log("   (no eligible fund transactions)\n");
      continue;
    }
    for (const [fundCode, txns] of [...byFund.entries()].sort()) {
      const pct = upfrontPctFor(agent.terms, fundCode, today);
      const res = computeWatermarkUpfront(txns, 0, pct);
      const buys = txns.filter((t) => t.direction === "BUY");
      const sells = txns.filter((t) => t.direction === "SELL");
      console.log(
        `   = ${fundCode}: ${buys.length} buys / ${sells.length} sells · net now ${fmt(res.netPrincipal)} · ` +
          `PEAK (watermark) ${fmt(res.peak)} · implied historical upfront @${(pct * 100).toFixed(4)}% = ${fmt(res.upfront)}`,
      );
      if (APPLY) {
        await prisma.agentUpfrontWatermark.upsert({
          where: { agentId_fundCode: { agentId: agent.id, fundCode } },
          create: { agentId: agent.id, fundCode, watermark: res.peak, throughDate: today },
          update: { watermark: res.peak, throughDate: today },
        });
        written++;
      }
    }
    console.log("");
  }

  console.log(APPLY ? `Done — ${written} watermark row(s) upserted.` : "Dry-run complete — re-run with --apply to write.");
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
