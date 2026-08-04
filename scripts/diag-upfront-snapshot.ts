// Deterministic JSON snapshot of every upfront figure the engine produces, so a
// refactor can be proven not to have moved money:
//
//   npx tsx scripts/diag-upfront-snapshot.ts > before.json
//   ...change code...
//   npx tsx scripts/diag-upfront-snapshot.ts > after.json
//   git diff --no-index before.json after.json      # must be empty
//
// Read-only. Emits the watermark state and the per-(investor, fund) attribution
// for every agent, plus the posted/pending totals. Keys are sorted so the output
// is stable across runs.
//
// Optional arg: billing cut-off (YYYY-MM-DD). Defaults to a FIXED date rather
// than today — "today" would make two runs differ for reasons unrelated to the
// code under test.

import { prisma } from "../src/lib/prisma";
import { computeAgentCommissionPreview, parseAsOf } from "../src/lib/agent-commission-preview";
import { getAgentBookShortfall } from "../src/lib/upfront-watermark";

async function main(): Promise<void> {
  const asOf = parseAsOf(process.argv[2] ?? "2026-08-04");

  const agents = await prisma.sellingAgent.findMany({
    select: { id: true, code: true },
    orderBy: { code: "asc" },
  });

  const out: Record<string, unknown> = { asOf: asOf.toISOString().slice(0, 10), agents: {} };
  const byAgent: Record<string, unknown> = {};

  for (const a of agents) {
    const p = await computeAgentCommissionPreview(prisma, a.id, asOf);
    const wm = p.upfrontWatermark;
    byAgent[a.code] = {
      totals: {
        pendingUpfront: p.totals.pendingUpfront,
        postedUpfront: p.totals.postedUpfront,
        trail: p.totals.trail,
        totalPayable: p.totals.totalPayable,
      },
      upfrontEntitled: p.upfrontEntitled,
      watermark: wm
        ? {
            storedWatermark: wm.storedWatermark,
            peak: wm.peak,
            currentNetPrincipal: wm.currentNetPrincipal,
            pendingIncrement: wm.pendingIncrement,
            pendingUpfront: wm.pendingUpfront,
            unratedFunds: wm.unratedFunds,
            legs: [...wm.legs]
              .sort((x, y) =>
                `${x.investorCode}|${x.fundCode}`.localeCompare(`${y.investorCode}|${y.fundCode}`),
              )
              .map((l) => ({
                key: `${l.investorCode}|${l.fundCode}`,
                netPrincipal: l.netPrincipal,
                attributedIncrement: l.attributedIncrement,
                upfrontPct: l.upfrontPct,
                attributedUpfront: l.attributedUpfront,
              })),
          }
        : null,
      // Per-bucket trail, to catch collateral damage to the trail engine.
      buckets: [...p.buckets]
        .sort((x, y) =>
          `${x.investorCode}|${x.fundCode}`.localeCompare(`${y.investorCode}|${y.fundCode}`),
        )
        .map((b) => ({
          key: `${b.investorCode}|${b.fundCode}`,
          inflowTotal: b.inflowTotal,
          trailTotal: b.trailTotal,
        })),
    };
  }

  out.agents = byAgent;
  console.log(JSON.stringify(out, null, 2));

  // Reconciliation, to stderr so stdout stays a clean diffable artifact.
  // Joins buckets to watermark legs exactly the way commission-breakdown.tsx and
  // the workbook Summary sheet do, and checks the column sums to pendingUpfront.
  // This is the regression guard for the "per-investor upfront disagrees with
  // the watermark" class of bug — the reason the initial/per-inflow columns went.
  console.error("\n=== Per-investor upfront vs watermark ===");
  let bad = 0;
  for (const a of agents) {
    const p = await computeAgentCommissionPreview(prisma, a.id, asOf);
    const legByKey = new Map(
      (p.upfrontWatermark?.legs ?? []).map((l) => [
        `${l.investorCode}|${l.fundCode}`,
        p.upfrontEntitled ? l.attributedUpfront : 0,
      ]),
    );
    const rows = p.buckets.map((b) => ({
      key: `${b.investorCode}|${b.fundCode}`,
      name: b.name,
      upfront: legByKey.get(`${b.investorCode}|${b.fundCode}`) ?? 0,
    }));
    const summed = Math.round(rows.reduce((s, r) => s + r.upfront, 0) * 100) / 100;
    const target = p.totals.pendingUpfront;
    const ok = Math.abs(summed - target) < 0.005;
    if (!ok) bad++;
    console.error(`\n${a.code}  rows sum ${summed.toFixed(2)} vs pendingUpfront ${target.toFixed(2)}  ${ok ? "OK" : "!! MISMATCH"}`);
    for (const r of rows) {
      console.error(`   ${r.key.padEnd(16)} ${(r.name || "").slice(0, 24).padEnd(26)} ${r.upfront.toFixed(2).padStart(12)}`);
    }
    // Legs with an upfront but no matching bucket would be money shown in the
    // watermark block and nowhere in the table.
    for (const [key, amt] of legByKey) {
      if (amt > 0 && !rows.some((r) => r.key === key)) {
        bad++;
        console.error(`   !! leg ${key} bills ${amt.toFixed(2)} but has no per-investor row`);
      }
    }
  }
  console.error(bad === 0 ? "\nAll agents reconcile." : `\n${bad} problem(s).`);

  // What /agent/calculator uses to stop projecting upfront on money that only
  // refills a shortfall left by earlier redemptions.
  console.error("\n=== Book shortfall (calculator input) ===");
  for (const a of agents) {
    const s = await getAgentBookShortfall(prisma, a.id, asOf);
    console.error(
      `  ${a.code.padEnd(8)} peak ${s.peak.toFixed(2).padStart(14)}  now ${s.netPrincipal.toFixed(2).padStart(14)}  shortfall ${s.shortfall.toFixed(2).padStart(14)}${s.shortfall > 0 ? "  ← below peak: new money earns no upfront until this is replaced" : ""}`,
    );
  }

  if (bad > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
