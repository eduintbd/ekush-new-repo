// Cutover from the per-(agent, investor) upfront watermark to the book-level
// one. 2026-08.
//
//   npx tsx scripts/restate-global-watermark.ts            # dry run
//   npx tsx scripts/restate-global-watermark.ts --apply    # writes
//
// WHY THE MODEL CHANGED
// Per-investor paid on the sum of each client's peak. Money moved out of
// client A and into client B under the same agent showed as a brand-new high
// in B's series and paid in full, though nothing new reached Ekush. There is
// no related-party field in the portal, so A and B are indistinguishable from
// two strangers and the churn cannot be detected. One peak for the whole book
// makes it arithmetically impossible instead.
//
// WHAT THIS DOES
//   1. Seeds xsystem.agent_book_upfront_watermarks to each agent's BOOK peak
//      through 2026-06-30 — the same "no back-payment" line the per-investor
//      seed used, recovered from the "prev watermark" figures recorded in the
//      posted rows' notes (2026-06-30 is the only month-end that reproduces
//      all of them).
//   2. Recomputes July 2026 book-wide from that seed and restates the posted
//      upfront rows to match.
//   3. Backs up the per-investor watermark rows to
//      prisma/migrations-manual/_dropped_investor_watermarks_backup.json,
//      following the precedent set by the per-fund cutover.
//
// A book peak can never exceed the sum of the individual peaks, so every
// change here is a reduction or a no-op. Nothing is paid or journalled (no row
// carries a journalBatchId, all are `accrued`, none has paidOn), so rows are
// corrected in place with the originals preserved in `notes`, never deleted.
//
// Run 06_agent_book_watermark.sql and `prisma db push` BEFORE this.

import { readFileSync, writeFileSync } from "fs";
for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, "");
}

import { prisma, withActor } from "@/lib/prisma";
import { categoryForFund, type FundCode } from "@/lib/ekush-web/types";
import {
  computeCombinedWatermarkUpfront,
  fetchAgentInvestorTxns,
  flattenToAgentSeries,
  type RateResolver,
} from "@/lib/upfront-watermark";

const SEED_THROUGH = new Date("2026-06-30T23:59:59.999Z");
const PERIOD_START = new Date("2026-07-01T00:00:00.000Z");
const PERIOD_END = new Date("2026-07-31T00:00:00.000Z");
const RUN_THROUGH = new Date("2026-07-31T23:59:59.999Z");
const BACKUP = "prisma/migrations-manual/_dropped_investor_watermarks_backup.json";
const STAMP =
  "Restated 2026-08-02: upfront watermark moved from per-(agent, investor) to the agent's whole book, " +
  "so money recycled between two of an agent's own clients no longer reads as new money.";

const n = (x: number) => x.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const same = (a: number, b: number) => Math.abs(a - b) < 0.01;

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(`${apply ? "APPLYING" : "DRY RUN"} — book-level watermark cutover\n`);

  const agents = await prisma.sellingAgent.findMany({
    where: { status: "approved" },
    include: { terms: true, investors: true },
    orderBy: { code: "asc" },
  });

  let seeded = 0;
  let upChanged = 0;
  let upReversed = 0;
  let upDelta = 0;
  const orphans: string[] = [];

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

    const seedSet = await fetchAgentInvestorTxns(prisma, a.id, SEED_THROUGH);
    const runSet = await fetchAgentInvestorTxns(prisma, a.id, RUN_THROUGH);
    if (runSet.byInvestor.size === 0) continue;

    let seed: number;
    let res;
    try {
      seed = computeCombinedWatermarkUpfront(
        flattenToAgentSeries(seedSet.byInvestor),
        0,
        rateFor,
      ).newWatermark;
      res = computeCombinedWatermarkUpfront(
        flattenToAgentSeries(runSet.byInvestor),
        seed,
        rateFor,
      );
    } catch (err) {
      console.log(`${a.code}  SKIPPED — ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (res.unratedFunds.length > 0) {
      console.log(`${a.code}  SKIPPED — no term for ${res.unratedFunds.join(", ")}`);
      continue;
    }

    // What the per-investor model held, for the comparison line only.
    const oldRows = await prisma.agentInvestorWatermark.findMany({ where: { agentId: a.id } });
    const oldSum = oldRows.reduce((s, w) => s + Number(w.watermark), 0);

    console.log(
      `${a.code.padEnd(8)} book seed @${SEED_THROUGH.toISOString().slice(0, 10)} ${n(seed).padStart(16)}` +
        `   book watermark ${n(res.newWatermark).padStart(16)}   (Σ per-investor was ${n(oldSum)})`,
    );
    seeded++;

    if (apply) {
      await withActor(null, (tx) =>
        tx.agentBookWatermark.upsert({
          where: { agentId: a.id },
          create: {
            agentId: a.id,
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
        }),
      );
    }

    // ── restate the posted July upfront rows ──
    const upRows = await prisma.commissionRun.findMany({
      where: { agentId: a.id, type: "upfront", periodStart: PERIOD_START, periodEnd: PERIOD_END },
    });
    const wantByKey = new Map(
      res.slices.filter((s) => s.upfront > 0).map((s) => [`${s.investorCode}|${s.fundCode}`, s]),
    );

    for (const row of upRows) {
      // The notes carry `investor {code} ` — the same token run-upfront writes
      // and the sign-fix restatement already parses.
      const m = /investor (\S+)/.exec(row.notes ?? "");
      const invCode = m?.[1] ?? "";
      const key = `${invCode}|${row.fundCode ?? ""}`;
      const want = wantByKey.get(key);
      const had = Number(row.amount);
      if (want) wantByKey.delete(key);

      if (want && same(had, want.upfront) && same(Number(row.baseAmount), want.base)) continue;
      if (!want && row.status === "reversed" && same(had, 0)) continue;

      if (!want) {
        console.log(`   ${invCode.padEnd(9)} ${row.fundCode}  ${n(had).padStart(12)} → REVERSED (book made no new high here)`);
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
                notes: `${row.notes ?? ""}\n${STAMP} Original base ${n(Number(row.baseAmount))} amount ${n(had)}; under the book watermark this money was already commissioned.`,
              },
            }),
          );
        }
      } else {
        console.log(`   ${invCode.padEnd(9)} ${row.fundCode}  ${n(had).padStart(12)} → ${n(want.upfront).padStart(12)}`);
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

    // Slices the July run never posted. Not written here — same stance the
    // sign-fix restatement took: a run posts money, a restatement corrects it.
    for (const [key, slice] of wantByKey) {
      orphans.push(`${a.code} ${key.replace("|", " ")} ${n(slice.upfront)} @ ${(slice.rate * 100).toFixed(4)}%`);
    }
  }

  // ── back up the retired per-investor rows ──
  const oldAll = await prisma.agentInvestorWatermark.findMany({ orderBy: [{ agentId: "asc" }, { investorCode: "asc" }] });
  const backup = oldAll.map((w) => ({
    agent_id: w.agentId,
    investor_code: w.investorCode,
    watermark: Number(w.watermark),
    net_principal: Number(w.netPrincipal),
    cip_offset: Number(w.cipOffset),
    through_date: w.throughDate.toISOString().slice(0, 10),
  }));
  if (apply) {
    writeFileSync(BACKUP, JSON.stringify(backup, null, 2));
    console.log(`\nBacked up ${backup.length} per-investor watermark row(s) → ${BACKUP}`);
    console.log("The rows themselves are LEFT IN PLACE. Drop the table only once this is signed off.");
  }

  console.log("\nSUMMARY");
  console.log(`  book watermarks seeded : ${seeded}`);
  console.log(`  upfront rows changed   : ${upChanged}   reversed: ${upReversed}   Δ ${n(upDelta)}`);
  if (orphans.length) {
    console.log(`\n  NOT POSTED by the original run (${orphans.length}) — left for a run to post, not written here:`);
    for (const o of orphans) console.log(`    ${o}`);
  }
  if (!apply) console.log("\nDry run — nothing written. Re-run with --apply once the figures above are agreed.");
}

main().finally(() => prisma.$disconnect());
