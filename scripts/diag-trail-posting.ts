// READ-ONLY diagnostic for selling-agent trail commission.
//
//   npx tsx scripts/diag-trail-posting.ts            # all agents
//   npx tsx scripts/diag-trail-posting.ts S00001     # one agent, with detail
//
// Answers the question "why is this agent's dashboard zero?" by putting the
// live preview and the posted ledger side by side. `drift` is the headline:
// non-zero means what the agent sees on screen and what has been posted to
// xsystem.commission_runs disagree.
//
// Writes nothing. Safe to run against production.

import { prisma } from "@/lib/prisma";
import { computeAgentCommissionPreview } from "@/lib/agent-commission-preview";

function n2(v: number): string {
  return v.toFixed(2).padStart(12);
}

async function main() {
  const only = process.argv[2]?.trim().toUpperCase();

  const agents = await prisma.sellingAgent.findMany({
    where: only ? { code: only } : { status: "approved" },
    select: { id: true, code: true, status: true },
    orderBy: { code: "asc" },
  });

  if (agents.length === 0) {
    console.log(only ? `No agent with code ${only}.` : "No approved agents.");
    return;
  }

  console.log(`as of ${new Date().toISOString()}\n`);
  console.log(
    "CODE     STATUS     PREVIEW TRAIL   POSTED TRAIL        DRIFT   ROWS(done/part)  OVERLAPS",
  );

  for (const a of agents) {
    const preview = await computeAgentCommissionPreview(prisma, a.id).catch((e) => {
      console.log(`${a.code.padEnd(8)} PREVIEW FAILED: ${String(e).slice(0, 120)}`);
      return null;
    });
    if (!preview) continue;

    const done = preview.trailRows.filter((r) => !r.partial);
    const partial = preview.trailRows.length - done.length;

    const agg = await prisma.commissionRun.aggregate({
      where: { agentId: a.id, type: "trail" },
      _sum: { amount: true },
      _count: true,
    });
    const posted = Number(agg._sum.amount ?? 0);
    const drift = preview.totals.trail - posted;

    // Overlapping (non-identical) posted periods — the double-pay signature.
    const rows = await prisma.commissionRun.findMany({
      where: { agentId: a.id, type: "trail" },
      select: { agentInvestorId: true, periodStart: true, periodEnd: true },
    });
    let overlapCount = 0;
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        const x = rows[i];
        const y = rows[j];
        if (x.agentInvestorId !== y.agentInvestorId) continue;
        if (!x.periodStart || !x.periodEnd || !y.periodStart || !y.periodEnd) continue;
        const identical = +x.periodStart === +y.periodStart && +x.periodEnd === +y.periodEnd;
        if (!identical && x.periodStart <= y.periodEnd && y.periodStart <= x.periodEnd) {
          overlapCount++;
        }
      }
    }

    console.log(
      `${a.code.padEnd(8)} ${a.status.padEnd(10)}${n2(preview.totals.trail)}${n2(posted)}${n2(drift)}` +
        `      ${String(done.length).padStart(3)}/${String(partial).padEnd(3)}      ${overlapCount || "-"}`,
    );

    if (only) {
      console.log(`\n  agent runs posted: ${agg._count} trail row(s)`);
      console.log(`  pending upfront:   ${preview.totals.pendingUpfront.toFixed(2)}`);
      console.log(`  posted upfront:    ${preview.totals.postedUpfront.toFixed(2)}`);
      console.log(`  total payable:     ${preview.totals.totalPayable.toFixed(2)}`);
      console.log(`  upfront entitled:  ${preview.upfrontEntitled}${preview.upfrontSuspendedFrom ? ` (suspended from ${preview.upfrontSuspendedFrom})` : ""}`);

      // Terms are the usual reason historical periods silently vanish.
      console.log("\n  TERMS IN EFFECT (applied retroactively to ALL periods):");
      for (const t of preview.termsActive) {
        console.log(
          `    ${t.fundCategory.padEnd(13)} upfront=${t.upfrontPct} Y1=${t.trailY1PctPa} Y2+=${t.trailY2PlusPctPa} ` +
            `${t.trailFrequency} from ${new Date(t.effectiveFrom).toISOString().slice(0, 10)}`,
        );
      }

      console.log("\n  LINKED INVESTORS:");
      for (const b of preview.buckets) {
        console.log(
          `    ${b.investorCode} ${b.fundCode} sourced ${new Date(b.sourcedOn).toISOString().slice(0, 10)} ` +
            `inflow=${b.inflowTotal.toFixed(2)} trail=${b.trailTotal.toFixed(2)}`,
        );
      }

      console.log("\n  LAST 6 TRAIL PERIODS:");
      for (const r of preview.trailRows.slice(-6)) {
        console.log(
          `    ${r.qLabel.padEnd(34)} ${r.tier.padEnd(4)} navPts=${String(r.navPoints).padStart(3)} ` +
            `avgValue=${r.avgValue.toFixed(2).padStart(12)} trail=${r.trail.toFixed(2).padStart(9)}${r.partial ? "  (partial)" : ""}`,
        );
      }
    }
  }

  console.log(
    "\ndrift = preview − posted. Non-zero means the agent's screen and the ledger disagree.",
  );
}

main().finally(() => prisma.$disconnect());
