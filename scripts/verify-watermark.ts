/* eslint-disable */
// Verify the watermark upfront engine: (1) unit-trace the user's 4-day
// example through the pure function; (2) dry-run the live data path for each
// approved agent (READ-ONLY — no CommissionRun/watermark writes).
// Run: npx tsx scripts/verify-watermark.ts

import { config } from "dotenv";
config({ path: ".env" });

import { PrismaClient } from "@/generated/prisma";
import { computeWatermarkUpfront, fetchAgentFundTxns, type WmTxn } from "@/lib/upfront-watermark";
import { categoryForFund } from "@/lib/ekush-web/types";

const prisma = new PrismaClient();
const d = (s: string) => new Date(`${s}T00:00:00Z`);

function unitTrace() {
  console.log("=== Unit trace: user's 4-day example (EGF, upfront 0.10%) ===");
  const pct = 0.001;
  // Net principal moves: Day1 +330k; Day2 −150k (BR0003 sells); Day3 +130k
  // (BR0004 buys); Day4 +140k (BR0004 buys). Cumulative: 330, 180, 310, 450.
  const days: Array<{ label: string; txns: WmTxn[] }> = [
    { label: "Day1", txns: [
      { date: d("2026-01-01"), direction: "BUY", amount: 100000 },
      { date: d("2026-01-01"), direction: "BUY", amount: 200000 },
      { date: d("2026-01-01"), direction: "BUY", amount: 30000 },
    ] },
    { label: "Day2", txns: [{ date: d("2026-01-02"), direction: "SELL", amount: 150000 }] },
    { label: "Day3", txns: [{ date: d("2026-01-03"), direction: "BUY", amount: 130000 }] },
    { label: "Day4", txns: [{ date: d("2026-01-04"), direction: "BUY", amount: 140000 }] },
  ];
  let stored = 0;
  const acc: WmTxn[] = [];
  for (const day of days) {
    acc.push(...day.txns);
    const r = computeWatermarkUpfront(acc, stored, pct);
    console.log(`  ${day.label}: net=${r.netPrincipal} peak=${r.peak} watermark ${stored}→${r.newWatermark} increment=${r.increment} upfront=${r.upfront}`);
    stored = r.newWatermark;
  }
  console.log("  expected upfront: 330, 0, 0, 120  | watermark: 330k,330k,330k,450k\n");
}

async function dryRunLive() {
  const through = new Date();
  const agents = await prisma.sellingAgent.findMany({ where: { status: "approved" }, include: { terms: true } });
  console.log(`=== Dry-run live data path (READ-ONLY) — ${agents.length} approved agent(s) ===`);
  for (const a of agents) {
    const byFund = await fetchAgentFundTxns(prisma, a.id, through);
    if (byFund.size === 0) { console.log(`  ${a.code} ${a.fullName}: no linked fund txns`); continue; }
    for (const [fundCode, txns] of byFund) {
      const cat = categoryForFund(fundCode as never);
      const term = a.terms.find((t) => t.fundCategory === cat);
      const pct = term ? Number(term.upfrontPct) : 0;
      const wm = await prisma.agentUpfrontWatermark.findUnique({ where: { agentId_fundCode: { agentId: a.id, fundCode } } });
      const r = computeWatermarkUpfront(txns, wm ? Number(wm.watermark) : 0, pct);
      console.log(`  ${a.code} ${fundCode}: ${txns.length} txns net=${r.netPrincipal} peak=${r.peak} storedWM=${wm ? Number(wm.watermark) : 0} pendingIncrement=${r.increment} pendingUpfront=${r.upfront} (rate ${(pct*100).toFixed(4)}%)`);
    }
  }
}

async function main() {
  unitTrace();
  await dryRunLive();
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
