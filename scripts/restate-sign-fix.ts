// Restatement of everything written before the redemption sign fix.
//
//   npx tsx scripts/restate-sign-fix.ts            # dry run — writes nothing
//   npx tsx scripts/restate-sign-fix.ts --apply    # writes
//
// WHAT WENT WRONG
// public.transactions stores executed SELLs with a NEGATIVE amount. The
// watermark engine negated that a second time, so redemptions ADDED to net
// invested principal: peaks were inflated, redeemed money was billed again on
// re-entry, and (via the same double negation in unitsAt) redeemed units kept
// earning trail. Fixed in src/lib/upfront-watermark.ts (principalDelta) and
// src/lib/agent-commission-preview.ts.
//
// WHAT THIS RESTATES
//   1. agent_investor_upfront_watermarks — every row was written by the
//      2026-07 upfront run and carries an inflated peak.
//   2. The 7 upfront CommissionRuns for 2026-07-01→2026-07-31.
//   3. Any trail CommissionRun whose amount the fixed engine disagrees with.
//
// HOW THE UPFRONT IS REBUILT
// The watermarks were originally seeded through 2026-06-30 (recovered from the
// "prev watermark" figures recorded in the posted rows' notes — 2026-06-30 is
// the only month-end whose pre-fix peaks reproduce all of them). So this
// rebuilds the same two steps the system actually took, with the engine fixed:
//   seed  = fixed peak through 2026-06-30      (forfeited, as agreed — unpaid)
//   july  = replay through 2026-07-31 from that seed  → the rows that should
//                                                       have posted
// Nothing here is paid or journalled (0 rows carry a journalBatchId, all are
// `accrued`, none has paidOn), so rows are corrected in place rather than
// offset with contra entries — the unique index on
// (agentInvestorId, type, periodStart, periodEnd) has no room for a second row
// in the same period anyway. A row that should never have existed is set to
// zero and marked `reversed`, never deleted.

import { readFileSync } from "fs";
for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, "");
}

import { prisma, withActor } from "@/lib/prisma";
import { categoryForFund, type FundCode } from "@/lib/ekush-web/types";
import {
  computeCombinedWatermarkUpfront,
  fetchAgentInvestorTxns,
  type RateResolver,
} from "@/lib/upfront-watermark";
import { computeAgentCommissionPreview } from "@/lib/agent-commission-preview";

/** The date the watermarks were seeded through — the "no back-payment" line. */
const SEED_THROUGH = new Date("2026-06-30T23:59:59.999Z");
const PERIOD_START = new Date("2026-07-01T00:00:00.000Z");
const PERIOD_END = new Date("2026-07-31T00:00:00.000Z");
const RUN_THROUGH = new Date("2026-07-31T23:59:59.999Z");
const STAMP = "Restated 2026-08-02: redemption sign fix (redemptions were being added to net principal).";

const n = (x: number) => x.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const same = (a: number, b: number) => Math.abs(a - b) < 0.01;

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(`${apply ? "APPLYING" : "DRY RUN"} — restatement of the pre-sign-fix numbers\n`);

  const agents = await prisma.sellingAgent.findMany({
    where: { status: "approved" },
    include: { terms: true, investors: true },
    orderBy: { code: "asc" },
  });

  let wmChanged = 0;
  let upChanged = 0;
  let upReversed = 0;
  let upDelta = 0;
  let trailChanged = 0;
  let trailDelta = 0;
  let missingTotal = 0;
  const unmatched: string[] = [];

  for (const a of agents) {
    const rateFor: RateResolver = (fundCode) => {
      const category = categoryForFund(fundCode as FundCode);
      const t = a.terms
        .filter(
          (x) =>
            x.fundCategory === category &&
            x.effectiveFrom <= PERIOD_END &&
            (x.effectiveTo === null || x.effectiveTo > PERIOD_END),
        )
        .sort((x, y) => +y.effectiveFrom - +x.effectiveFrom)[0];
      return t ? { rate: Number(t.upfrontPct), category } : null;
    };

    // (investorCode, fundCode) → link id, as run-upfront resolves it.
    const linkByPair = new Map<string, string>();
    for (const l of a.investors) {
      const key = `${l.investorCode}|${l.fundCode}`;
      const cur = a.investors
        .filter((x) => `${x.investorCode}|${x.fundCode}` === key)
        .sort((x, y) => +x.sourcedOn - +y.sourcedOn)[0];
      linkByPair.set(key, cur.id);
    }

    const seedSet = await fetchAgentInvestorTxns(prisma, a.id, SEED_THROUGH);
    const runSet = await fetchAgentInvestorTxns(prisma, a.id, RUN_THROUGH);
    if (runSet.byInvestor.size === 0) continue;

    const wmRows = await prisma.agentInvestorWatermark.findMany({ where: { agentId: a.id } });
    const wmByInvestor = new Map(wmRows.map((w) => [w.investorCode, w]));
    const upRows = await prisma.commissionRun.findMany({
      where: { agentId: a.id, type: "upfront", periodStart: PERIOD_START, periodEnd: PERIOD_END },
    });

    let printedAgent = false;
    const head = () => {
      if (!printedAgent) console.log(`AGENT ${a.code} — ${a.fullName}`);
      printedAgent = true;
    };

    for (const [investorCode, txns] of runSet.byInvestor) {
      const seedTxns = seedSet.byInvestor.get(investorCode) ?? [];
      let seed: number;
      let res;
      try {
        seed = computeCombinedWatermarkUpfront(seedTxns, 0, rateFor).newWatermark;
        res = computeCombinedWatermarkUpfront(txns, seed, rateFor);
      } catch (err) {
        head();
        console.log(`  ${investorCode}  SKIPPED — ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (res.unratedFunds.length > 0) {
        head();
        console.log(`  ${investorCode}  SKIPPED — no term for ${res.unratedFunds.join(", ")}`);
        continue;
      }

      // ── watermark ──
      const wm = wmByInvestor.get(investorCode);
      const storedWm = wm ? Number(wm.watermark) : 0;
      if (!same(storedWm, res.newWatermark)) {
        head();
        console.log(
          `  ${investorCode.padEnd(9)} watermark ${n(storedWm).padStart(16)} → ${n(res.newWatermark).padStart(16)}   (seed at ${ymd(SEED_THROUGH)}: ${n(seed)})`,
        );
        wmChanged++;
        if (apply) {
          await prisma.agentInvestorWatermark.upsert({
            where: { agentId_investorCode: { agentId: a.id, investorCode } },
            create: {
              agentId: a.id,
              investorCode,
              watermark: res.newWatermark,
              netPrincipal: res.netPrincipal,
              cipOffset: res.cipOffset,
              throughDate: PERIOD_END,
            },
            update: {
              watermark: res.newWatermark,
              netPrincipal: res.netPrincipal,
              cipOffset: res.cipOffset,
              throughDate: PERIOD_END,
            },
          });
        }
      }

      // ── the July upfront rows for this investor ──
      const mine = upRows.filter((r) => (r.notes ?? "").includes(`investor ${investorCode} `));
      const wantByFund = new Map(res.slices.filter((s) => s.upfront > 0).map((s) => [s.fundCode, s]));

      for (const row of mine) {
        const want = row.fundCode ? wantByFund.get(row.fundCode) : undefined;
        const had = Number(row.amount);
        if (want) wantByFund.delete(row.fundCode!);
        if (want && same(had, want.upfront) && same(Number(row.baseAmount), want.base)) continue;
        // Already restated on an earlier run — leave it, don't stamp it twice.
        if (!want && row.status === "reversed" && same(had, 0)) continue;

        head();
        if (!want) {
          console.log(`  ${investorCode.padEnd(9)} upfront ${row.fundCode}  ${n(had).padStart(12)} → REVERSED (no new money above the true peak)`);
          upReversed++;
          upDelta -= had;
          if (apply) {
            await withActor(null, (tx) =>
              tx.commissionRun.update({
                where: { id: row.id },
                data: {
                  baseAmount: 0,
                  amount: 0,
                  status: "reversed",
                  notes: `${row.notes ?? ""}\n${STAMP} Original base ${n(Number(row.baseAmount))} amount ${n(had)}; the true peak never rose above the watermark, so nothing was earned.`,
                },
              }),
            );
          }
        } else {
          console.log(`  ${investorCode.padEnd(9)} upfront ${row.fundCode}  ${n(had).padStart(12)} → ${n(want.upfront).padStart(12)}   base ${n(Number(row.baseAmount))} → ${n(want.base)}`);
          upChanged++;
          upDelta += want.upfront - had;
          if (apply) {
            await withActor(null, (tx) =>
              tx.commissionRun.update({
                where: { id: row.id },
                data: {
                  baseAmount: want.base,
                  amount: want.upfront,
                  rateApplied: want.rate,
                  notes: `${row.notes ?? ""}\n${STAMP} Original base ${n(Number(row.baseAmount))} amount ${n(had)}.`,
                },
              }),
            );
          }
        }
      }

      // A slice the buggy run never posted at all. Correcting the seed
      // downward turns money that was believed forfeited into a genuine new
      // high, so these are real — but they are NOT written here. Every one of
      // them belongs to an agent whose upfront term is a suspected percent
      // literal (20% where 0.20% was meant), which would multiply them by 100.
      // Fix the term, then let the next run post them normally.
      for (const [fundCode, slice] of wantByFund) {
        head();
        console.log(`  ${investorCode.padEnd(9)} upfront ${fundCode}  NOT POSTED by the original run → would be ${n(slice.upfront)} at ${(slice.rate * 100).toFixed(4)}%`);
        missingTotal += slice.upfront;
        unmatched.push(`${a.code} ${investorCode} ${fundCode} ${n(slice.upfront)} @ ${(slice.rate * 100).toFixed(4)}%`);
      }
    }

    // ── trail rows ──
    const preview = await computeAgentCommissionPreview(prisma, a.id).catch(() => null);
    if (!preview) {
      console.log(`  (trail skipped — preview failed for ${a.code})`);
      continue;
    }
    const freshTrail = new Map<string, number>();
    for (const r of preview.trailRows) {
      freshTrail.set(`${r.agentInvestorId}|${ymd(r.quarterStart)}|${ymd(r.quarterEnd)}`, r.trail);
    }
    const trailRows = await prisma.commissionRun.findMany({ where: { agentId: a.id, type: "trail" } });
    for (const row of trailRows) {
      if (!row.agentInvestorId || !row.periodStart || !row.periodEnd) continue;
      const key = `${row.agentInvestorId}|${ymd(row.periodStart)}|${ymd(row.periodEnd)}`;
      const fresh = freshTrail.get(key);
      const had = Number(row.amount);
      if (fresh === undefined) {
        // The fixed engine generates no row for this period at all — the link
        // held nothing. On S00001/A00005 that is a SELL of 9,236 units against
        // 4,236 ever bought under this agent: the investor was redeeming units
        // acquired outside the agent's window, which the model does not carry.
        // That is a data problem of its own, not sign damage, so it is reported
        // and left alone.
        unmatched.push(`${a.code} trail ${ymd(row.periodStart)}→${ymd(row.periodEnd)} ${n(had)} — fixed engine generates no row (nothing held)`);
        continue;
      }
      if (same(fresh, had)) continue;
      head();
      console.log(`  trail ${ymd(row.periodStart)}→${ymd(row.periodEnd)}  ${n(had).padStart(12)} → ${n(fresh).padStart(12)}`);
      trailChanged++;
      trailDelta += fresh - had;
      if (apply) {
        await withActor(null, (tx) =>
          tx.commissionRun.update({
            where: { id: row.id },
            data: {
              amount: fresh,
              notes: `${row.notes ?? ""}\n${STAMP} Original amount ${n(had)} — redeemed units were still being counted as held.`,
            },
          }),
        );
      }
    }

    if (printedAgent) console.log("");
  }

  console.log("SUMMARY");
  console.log(`  watermarks restated : ${wmChanged}`);
  console.log(`  upfront rows changed: ${upChanged}   reversed: ${upReversed}   Δ ${n(upDelta)}`);
  console.log(`  trail rows changed  : ${trailChanged}   Δ ${n(trailDelta)}`);
  console.log(`  upfront NOT posted  : ${n(missingTotal)} across ${unmatched.filter((u) => !u.includes("trail")).length} slices — see below, deliberately not written`);
  if (unmatched.length) {
    console.log(`\n  NEEDS A HUMAN (${unmatched.length}) — not touched:`);
    for (const u of unmatched) console.log(`    ${u}`);
  }
  if (!apply) console.log("\nDry run — nothing written. Re-run with --apply once the figures above are agreed.");
}

main().finally(() => prisma.$disconnect());
