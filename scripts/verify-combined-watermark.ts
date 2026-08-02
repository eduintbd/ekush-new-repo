// Verification for the combined-fund upfront watermark.
//
//   npx tsx scripts/verify-combined-watermark.ts              # unit traces only
//   npx tsx scripts/verify-combined-watermark.ts --compare    # + live old-vs-new
//   npx tsx scripts/verify-combined-watermark.ts --compare --agent BI0000
//
// The unit traces are the only real test coverage this money engine will ever
// have (there is no test framework in this repo), so they assert hand-computed
// values and exit non-zero on any mismatch. Run them green BEFORE touching any
// caller or the database.
//
// --compare is READ-ONLY. It replays every approved agent under both the old
// per-fund model and the new combined model from a zero baseline — which is
// the true current state, since agent_upfront_watermarks is empty — so the AMC
// can see the money difference before anything is ever posted.

import {
  computeCombinedWatermarkUpfront,
  computeWatermarkUpfront,
  fetchAgentInvestorTxns,
  orderForReplay,
  type RateResolver,
  type WmTxn,
} from "@/lib/upfront-watermark";
import { categoryForFund, type FundCode } from "@/lib/ekush-web/types";
import { prisma } from "@/lib/prisma";

const EQUITY = 0.001; // 0.10%
const FIXED = 0.0015; // 0.15% — deliberately different from equity so the
//                       two-rate split is actually exercised.

const rateFor: RateResolver = (fundCode) => {
  const category = categoryForFund(fundCode as FundCode);
  return { rate: category === "equity" ? EQUITY : FIXED, category };
};

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const buy = (date: string, fundCode: string, amount: number): WmTxn => ({
  date: d(date), direction: "BUY", amount, fundCode, source: "txn",
});
const sell = (date: string, fundCode: string, amount: number): WmTxn => ({
  date: d(date), direction: "SELL", amount, fundCode, source: "txn",
});
const cip = (date: string, fundCode: string, amount: number): WmTxn => ({
  date: d(date), direction: "SELL", amount, fundCode, source: "cip",
});

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`   ${ok ? "OK  " : "FAIL"} ${label.padEnd(46)} got ${a}${ok ? "" : `  want ${e}`}`);
}

function unitTraces() {
  console.log("UNIT TRACES\n");

  // S1 — regression guard: the original single-fund example still behaves.
  console.log("S1  single fund, 4 movements (regression guard)");
  {
    const t = [buy("2026-01-01", "EGF", 330_000)];
    const r1 = computeCombinedWatermarkUpfront(t, 0, rateFor);
    check("day1 increment", r1.increment, 330_000);
    check("day1 upfront", r1.upfront, 330);
    check("day1 watermark", r1.newWatermark, 330_000);
    const t2 = [...t, sell("2026-01-02", "EGF", 150_000)];
    const r2 = computeCombinedWatermarkUpfront(t2, 330_000, rateFor);
    check("day2 increment (redemption)", r2.increment, 0);
    const t4 = [...t2, buy("2026-01-04", "EGF", 270_000)];
    const r4 = computeCombinedWatermarkUpfront(t4, 330_000, rateFor);
    check("day4 increment (new peak 450k)", r4.increment, 120_000);
    check("day4 upfront", r4.upfront, 120);
  }

  // S2 — THE AMC CASE. Same-day switch ESRF → EFUF.
  console.log("\nS2  the switch: ESRF -200k / EFUF +250k same day, stored 200k");
  {
    const t = [
      buy("2024-01-10", "ESRF", 200_000),
      sell("2026-03-01", "ESRF", 200_000),
      buy("2026-03-01", "EFUF", 250_000),
    ];
    const r = computeCombinedWatermarkUpfront(t, 200_000, rateFor);
    check("increment (only genuine new money)", r.increment, 50_000);
    check("slice count", r.slices.length, 1);
    check("slice fund", r.slices[0]?.fundCode, "EFUF");
    check("slice base", r.slices[0]?.base, 50_000);
    check("upfront @ equity 0.10%", r.upfront, 50);
    check("watermark", r.newWatermark, 250_000);

    // What the OLD per-fund model would have paid, for the comparison story.
    const efufOnly = t.filter((x) => x.fundCode === "EFUF");
    const old = computeWatermarkUpfront(efufOnly, 0, EQUITY);
    console.log(`   note  old per-fund model paid on ${old.increment.toLocaleString()} = ${old.upfront} (EFUF watermark started at 0)`);
  }

  // S3 — one investor spanning two categories ⇒ two slices, two rates.
  console.log("\nS3  two-rate split: ESRF +100k then EFUF +300k, stored 0");
  {
    const t = [buy("2026-01-05", "ESRF", 100_000), buy("2026-02-10", "EFUF", 300_000)];
    const r = computeCombinedWatermarkUpfront(t, 0, rateFor);
    check("increment", r.increment, 400_000);
    check("slice count", r.slices.length, 2);
    check("ESRF base", r.slices.find((s) => s.fundCode === "ESRF")?.base, 100_000);
    check("EFUF base", r.slices.find((s) => s.fundCode === "EFUF")?.base, 300_000);
    // 100k × 0.15% + 300k × 0.10% = 150 + 300
    check("upfront (blended)", r.upfront, 450);
  }

  // S4 — ordering: same input as S2 but fed BUY-first.
  console.log("\nS4  ordering: S2 fed BUY-before-SELL must still give 50k");
  {
    const t = [
      buy("2024-01-10", "ESRF", 200_000),
      buy("2026-03-01", "EFUF", 250_000), // deliberately before the SELL
      sell("2026-03-01", "ESRF", 200_000),
    ];
    const r = computeCombinedWatermarkUpfront(t, 200_000, rateFor);
    check("increment (SELL-first policy)", r.increment, 50_000);
    check("ordered SELL before BUY", orderForReplay(t).map((x) => x.direction).join(","), "BUY,SELL,BUY");
  }

  // S5 — CIP reinvestment must not count as new money.
  console.log("\nS5  CIP reinvestment excluded");
  {
    const matched = [
      buy("2026-01-01", "EFUF", 100_000),
      cip("2026-06-30", "EFUF", 5_000),
      buy("2026-07-02", "EFUF", 5_000), // the reinvestment booked as a BUY
    ];
    const r = computeCombinedWatermarkUpfront(matched, 0, rateFor);
    check("peak excludes the reinvestment", r.peak, 100_000);
    check("increment", r.increment, 100_000);
    check("cipOffset reported", r.cipOffset, 5_000);

    // Orphan: the dividend is recorded but the reinvestment BUY was never
    // booked. The offset still applies, so net principal drops while the peak
    // holds — nothing extra is paid now, and the investor's NEXT genuine 5,000
    // earns nothing because it only refills back to the old peak. That is the
    // deliberate underpayment: with no clawback, erring under is the only safe
    // direction.
    const orphan = [buy("2026-01-01", "EFUF", 100_000), cip("2026-06-30", "EFUF", 5_000)];
    const ro = computeCombinedWatermarkUpfront(orphan, 0, rateFor);
    check("orphan: net principal carries the offset", ro.netPrincipal, 95_000);
    check("orphan: peak still never falls", ro.peak, 100_000);
    const afterOrphan = computeCombinedWatermarkUpfront(
      [...orphan, buy("2026-08-01", "EFUF", 5_000)],
      ro.newWatermark,
      rateFor,
    );
    check("orphan: next genuine 5k earns nothing (underpay)", afterOrphan.increment, 0);
  }

  // S6 — investors are independent of each other.
  console.log("\nS6  per-investor independence");
  {
    const a = computeCombinedWatermarkUpfront([sell("2026-03-01", "EFUF", 200_000)], 200_000, rateFor);
    const b = computeCombinedWatermarkUpfront([buy("2026-03-01", "EFUF", 200_000)], 0, rateFor);
    check("investor A (redeemed) earns nothing", a.increment, 0);
    check("investor B (new money) still earns", b.increment, 200_000);
  }

  // S7 — idempotency.
  console.log("\nS7  idempotency");
  {
    const t = [buy("2026-01-01", "EFUF", 100_000)];
    const first = computeCombinedWatermarkUpfront(t, 0, rateFor);
    const second = computeCombinedWatermarkUpfront(t, first.newWatermark, rateFor);
    check("second run increment", second.increment, 0);
    check("second run slices", second.slices.length, 0);
  }

  // S8 — a SELL with no in-window BUY.
  console.log("\nS8  negative running is flagged, pays nothing");
  {
    const t = [sell("2026-01-01", "EFUF", 50_000), buy("2026-02-01", "EFUF", 30_000)];
    const r = computeCombinedWatermarkUpfront(t, 0, rateFor);
    check("peak", r.peak, 0);
    check("upfront", r.upfront, 0);
    check("negativeRunningSeen", r.negativeRunningSeen, true);
  }

  // S9 — a fund with no active term must block, not silently skip.
  console.log("\nS9  unrated fund blocks the investor");
  {
    const onlyEquity: RateResolver = (f) =>
      f === "EFUF" ? { rate: EQUITY, category: "equity" } : null;
    const t = [buy("2026-01-01", "ESRF", 100_000)];
    const r = computeCombinedWatermarkUpfront(t, 0, onlyEquity);
    check("unratedFunds", r.unratedFunds, ["ESRF"]);
    check("no slices", r.slices.length, 0);
  }

  // S10 — THE SIGN BUG. public.transactions stores executed SELLs with a
  // NEGATIVE amount (1,866 of 1,868 rows). The engine used to negate that
  // again, so a redemption ADDED to net principal and lifted the watermark.
  // Agent S00004's screen read A00699 at 105,500,000 net principal against a
  // true 42,500,000, and re-billed the redeemed money when it came back.
  console.log("\nS10 portal sign convention: SELL amounts arrive negative");
  {
    const t = [
      buy("2026-01-01", "EFUF", 200_000),
      sell("2026-02-01", "EFUF", -150_000), // as the portal stores it
    ];
    const r = computeCombinedWatermarkUpfront(t, 200_000, rateFor);
    check("negative SELL reduces principal", r.netPrincipal, 50_000);
    check("peak holds, nothing new to pay", r.increment, 0);

    // Refilling below the peak must still earn nothing.
    const back = computeCombinedWatermarkUpfront(
      [...t, buy("2026-03-01", "EFUF", 150_000)],
      200_000,
      rateFor,
    );
    check("refill to the old peak earns nothing", back.increment, 0);

    // Both sign conventions must land on the same number.
    const positiveConvention = computeCombinedWatermarkUpfront(
      [buy("2026-01-01", "EFUF", 200_000), sell("2026-02-01", "EFUF", 150_000)],
      200_000,
      rateFor,
    );
    check("sign convention is immaterial", positiveConvention.netPrincipal, r.netPrincipal);

    // A negative BUY is a correction/reversal — it must NOT be flipped into a
    // subscription by taking its magnitude.
    const reversal = computeCombinedWatermarkUpfront(
      [buy("2026-01-01", "EFUF", 200_000), buy("2026-01-05", "EFUF", -200_000)],
      0,
      rateFor,
    );
    check("negative BUY reverses, not adds", reversal.netPrincipal, 0);
  }

  // S11 — agent S00004, the case that exposed the bug. Real transactions,
  // hand-checked against the AMC's own workbook.
  console.log("\nS11 agent S00004 replay (all rates 0.10%)");
  {
    const flat: RateResolver = (fundCode) => ({
      rate: 0.001,
      category: categoryForFund(fundCode as FundCode),
    });
    // A00699: 7.5m + 15m + 20m in, 31.5m out, 31.5m back in ⇒ peak 42.5m.
    const a699 = computeCombinedWatermarkUpfront(
      [
        buy("2026-02-18", "ESRF", 7_500_000),
        buy("2026-03-03", "ESRF", 15_000_000),
        buy("2026-03-16", "ESRF", 20_000_000),
        sell("2026-06-29", "ESRF", -31_500_000),
        buy("2026-06-30", "ESRF", 31_500_000),
      ],
      0,
      flat,
    );
    check("A00699 net principal", a699.netPrincipal, 42_500_000);
    check("A00699 peak", a699.peak, 42_500_000);
    check("A00699 upfront", a699.upfront, 42_500);

    // A00713: 15m ESRF, out 11.5m, 11.5m EFUF, out 10m, 10m ESRF ⇒ peak 15m.
    const a713 = computeCombinedWatermarkUpfront(
      [
        buy("2026-04-05", "ESRF", 15_000_000),
        sell("2026-06-30", "ESRF", -11_500_000),
        buy("2026-07-02", "EFUF", 11_500_000),
        sell("2026-07-12", "EFUF", -10_000_000),
        buy("2026-07-15", "ESRF", 10_000_000),
      ],
      0,
      flat,
    );
    check("A00713 net principal", a713.netPrincipal, 15_000_000);
    check("A00713 peak", a713.peak, 15_000_000);
    check("A00713 upfront", a713.upfront, 15_000);

    const a820 = computeCombinedWatermarkUpfront(
      [buy("2026-06-30", "EFUF", 500_000)],
      0,
      flat,
    );
    check("A00820 upfront", a820.upfront, 500);
    check("agent total upfront", a699.upfront + a713.upfront + a820.upfront, 58_000);
  }
}

async function compareLive(onlyAgent?: string) {
  console.log("\n\nLIVE COMPARISON (read-only, from a zero baseline)\n");
  const agents = await prisma.sellingAgent.findMany({
    where: onlyAgent ? { code: onlyAgent } : { status: "approved" },
    include: { terms: true },
    orderBy: { code: "asc" },
  });
  const asOf = new Date();

  console.log("CODE      OLD (per-fund)   NEW (combined)          DELTA   CIP EXCL   INV  WARN");
  for (const a of agents) {
    const resolver: RateResolver = (fundCode) => {
      const category = categoryForFund(fundCode as FundCode);
      const t = a.terms
        .filter((x) => x.fundCategory === category && x.effectiveFrom <= asOf && (x.effectiveTo === null || x.effectiveTo > asOf))
        .sort((x, y) => +y.effectiveFrom - +x.effectiveFrom)[0];
      return t ? { rate: Number(t.upfrontPct), category } : null;
    };

    const { byInvestor, warnings, cipOffsetTotal } = await fetchAgentInvestorTxns(prisma, a.id, asOf);

    // NEW: per investor, combined, CIP excluded.
    let newTotal = 0;
    const perInvestor: Array<{ code: string; upfront: number; slices: string }> = [];
    for (const [code, txns] of byInvestor) {
      const r = computeCombinedWatermarkUpfront(txns, 0, resolver);
      newTotal += r.upfront;
      if (r.upfront > 0 || r.unratedFunds.length) {
        perInvestor.push({
          code,
          upfront: r.upfront,
          slices: r.slices.map((s) => `${s.fundCode} ${s.base.toFixed(0)}@${(s.rate * 100).toFixed(4)}%`).join(" + ")
            + (r.unratedFunds.length ? ` [BLOCKED: no term for ${r.unratedFunds.join(",")}]` : ""),
        });
      }
    }

    // OLD: per fund, CIP counted, exactly as the retired model did.
    const { byInvestor: rawByInv } = await fetchAgentInvestorTxns(prisma, a.id, asOf, { excludeCip: false });
    const byFund = new Map<string, WmTxn[]>();
    for (const txns of rawByInv.values()) {
      for (const t of txns) {
        const arr = byFund.get(t.fundCode) ?? [];
        arr.push(t);
        byFund.set(t.fundCode, arr);
      }
    }
    let oldTotal = 0;
    for (const [fundCode, txns] of byFund) {
      const res = resolver(fundCode);
      if (!res) continue; // old model silently skipped unrated funds
      oldTotal += computeWatermarkUpfront(txns, 0, res.rate).upfront;
    }

    console.log(
      `${a.code.padEnd(8)}${oldTotal.toFixed(2).padStart(15)}${newTotal.toFixed(2).padStart(17)}` +
        `${(newTotal - oldTotal).toFixed(2).padStart(15)}${cipOffsetTotal.toFixed(2).padStart(11)}` +
        `${String(byInvestor.size).padStart(5)}${String(warnings.length).padStart(6)}`,
    );

    if (onlyAgent) {
      for (const p of perInvestor.sort((x, y) => y.upfront - x.upfront)) {
        console.log(`     ${p.code.padEnd(9)} ${p.upfront.toFixed(2).padStart(12)}   ${p.slices}`);
      }
      for (const w of warnings) {
        console.log(`     WARN ${w.kind.padEnd(20)} ${w.investorCode} ${w.fundCode ?? ""} — ${w.detail}`);
      }
    }
  }
  console.log("\nDELTA is what the combined model changes. Causes: fund-switch double count removed,");
  console.log("CIP reinvestment excluded, rate re-attribution, direct-subscription/as-of filtering.");
}

/**
 * Per-investor (live) vs global per-agent watermark, read-only, from a zero
 * baseline — the money decision behind the 2026-08 model change.
 *
 * A global peak is the peak of a SUM; the live model pays on the SUM of peaks.
 * The peak of a sum can never exceed the sum of peaks, so global always pays
 * the same or less. The gap is exactly the money that left one of the agent's
 * clients and arrived at another — internal recycling that the per-investor
 * model books as a brand-new high under the receiving client.
 *
 * Totals only, deliberately. Attributing the global increment to a particular
 * investor needs `investorCode` on the slice, which the engine does not carry
 * yet; re-deriving it here would mean a second copy of the money logic in a
 * verification script, which is the one place it must not live.
 */
async function compareGlobal(onlyAgent?: string) {
  console.log("\n\nPER-INVESTOR vs GLOBAL WATERMARK (read-only, from a zero baseline)\n");

  // Every agent with investors, not just approved ones: S00004 is `pending`
  // and is the case that prompted the change.
  const agents = await prisma.sellingAgent.findMany({
    where: onlyAgent ? { code: onlyAgent } : {},
    include: { terms: true },
    orderBy: { code: "asc" },
  });
  const asOf = new Date();
  const money = (x: number) => x.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  console.log("CODE      STATUS      PER-INVESTOR         GLOBAL          DELTA   INV  WARN");
  let totPer = 0;
  let totGlobal = 0;
  const detail: Array<{ agent: string; lines: string[] }> = [];

  for (const a of agents) {
    const resolver: RateResolver = (fundCode) => {
      const category = categoryForFund(fundCode as FundCode);
      const t = a.terms
        .filter((x) => x.fundCategory === category && x.effectiveFrom <= asOf && (x.effectiveTo === null || x.effectiveTo > asOf))
        .sort((x, y) => +y.effectiveFrom - +x.effectiveFrom)[0];
      return t ? { rate: Number(t.upfrontPct), category } : null;
    };

    const { byInvestor, warnings } = await fetchAgentInvestorTxns(prisma, a.id, asOf);
    if (byInvestor.size === 0) continue;

    // Live model: one replay per investor, summed.
    let perInvestor = 0;
    const lines: string[] = [];
    let blocked = false;
    for (const [code, txns] of byInvestor) {
      let r;
      try {
        r = computeCombinedWatermarkUpfront(txns, 0, resolver);
      } catch (err) {
        blocked = true;
        lines.push(`  ${code.padEnd(9)} ATTRIBUTION ERROR — ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (r.unratedFunds.length) {
        blocked = true;
        lines.push(`  ${code.padEnd(9)} BLOCKED — no term for ${r.unratedFunds.join(", ")}`);
        continue;
      }
      perInvestor += r.upfront;
      if (r.upfront > 0) lines.push(`  ${code.padEnd(9)} peak ${money(r.peak).padStart(16)}   upfront ${money(r.upfront).padStart(12)}`);
    }

    // Proposed model: one replay over every movement the agent sourced.
    const flat = [...byInvestor.values()].flat();
    let global = 0;
    let globalPeak = 0;
    try {
      const g = computeCombinedWatermarkUpfront(flat, 0, resolver);
      global = g.upfront;
      globalPeak = g.peak;
    } catch (err) {
      blocked = true;
      lines.push(`  GLOBAL ATTRIBUTION ERROR — ${err instanceof Error ? err.message : String(err)}`);
    }

    totPer += perInvestor;
    totGlobal += global;

    console.log(
      `${a.code.padEnd(8)}${a.status.padEnd(11)}${money(perInvestor).padStart(14)}${money(global).padStart(15)}` +
        `${money(global - perInvestor).padStart(15)}${String(byInvestor.size).padStart(6)}${String(warnings.length).padStart(6)}` +
        `${blocked ? "  (see detail)" : ""}`,
    );

    if (Math.abs(global - perInvestor) > 0.01 || blocked || onlyAgent) {
      lines.unshift(`  ${"book peak".padEnd(9)} ${money(globalPeak).padStart(16)}   vs Σ investor peaks`);
      detail.push({ agent: `${a.code} — ${a.fullName}`, lines });
    }
  }

  console.log(`${"".padEnd(19)}${money(totPer).padStart(14)}${money(totGlobal).padStart(15)}${money(totGlobal - totPer).padStart(15)}`);

  for (const d of detail) {
    console.log(`\n${d.agent}`);
    for (const l of d.lines) console.log(l);
  }

  console.log("\nDELTA is what switching to a global watermark costs the agent. It can never be");
  console.log("positive: the peak of a sum cannot exceed the sum of peaks. The gap is money that");
  console.log("moved between two of the agent's own clients — new money under the per-investor");
  console.log("model, no new money at all under the global one.");
}

async function main() {
  unitTraces();
  const args = process.argv.slice(2);
  const agentArg = () => {
    const i = args.indexOf("--agent");
    return i >= 0 ? args[i + 1]?.toUpperCase() : undefined;
  };
  if (args.includes("--compare")) {
    await compareLive(agentArg());
  }
  if (args.includes("--compare-global")) {
    await compareGlobal(agentArg());
  }
  console.log(failures === 0 ? "\nALL UNIT TRACES PASSED" : `\n${failures} UNIT TRACE(S) FAILED`);
  if (failures > 0) process.exitCode = 1;
}

main().finally(() => prisma.$disconnect());
