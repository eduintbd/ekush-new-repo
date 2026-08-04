// Read-only proof that the billing cut-off actually moves the numbers:
// computes each agent's preview at a back-dated cut-off and at today, and
// prints both side by side.
//
//   npx tsx scripts/diag-asof-preview.ts 2026-07-30

import { prisma } from "../src/lib/prisma";
import { computeAgentCommissionPreview, parseAsOf } from "../src/lib/agent-commission-preview";

async function main(): Promise<void> {
  const arg = process.argv[2] ?? "2026-07-30";
  const cut = parseAsOf(arg);
  const now = new Date();
  console.log(`Comparing as-of ${cut.toISOString().slice(0, 10)} vs today ${now.toISOString().slice(0, 10)}\n`);

  const agents = await prisma.sellingAgent.findMany({
    select: { id: true, code: true, fullName: true },
    orderBy: { code: "asc" },
  });

  for (const a of agents) {
    const [atCut, atNow] = await Promise.all([
      computeAgentCommissionPreview(prisma, a.id, cut),
      computeAgentCommissionPreview(prisma, a.id, now),
    ]);
    const f = (n: number) => n.toFixed(2).padStart(14);
    console.log(`${a.code} — ${a.fullName}`);
    console.log(`                     ${arg.padStart(14)} ${"today".padStart(14)}`);
    console.log(`  total inflow      ${f(atCut.totals.inflow)} ${f(atNow.totals.inflow)}`);
    console.log(`  pending upfront   ${f(atCut.totals.pendingUpfront)} ${f(atNow.totals.pendingUpfront)}`);
    console.log(`  trail (to date)   ${f(atCut.totals.trail)} ${f(atNow.totals.trail)}`);
    console.log(`  TOTAL PAYABLE     ${f(atCut.totals.totalPayable)} ${f(atNow.totals.totalPayable)}`);
    console.log(
      `  trail rows        ${String(atCut.trailRows.length).padStart(14)} ${String(atNow.trailRows.length).padStart(14)}   (partial: ${atCut.trailRows.filter((r) => r.partial).length} / ${atNow.trailRows.filter((r) => r.partial).length})`,
    );
    // The retired upfront bases must be gone from the shape, not merely hidden
    // — a field that still exists is a field something will render again.
    for (const gone of ["perInflowUpfront", "initialUpfront"]) {
      if (gone in (atNow.totals as Record<string, unknown>)) {
        console.log(`  !! totals still carries ${gone}`);
      }
    }
    console.log("");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
