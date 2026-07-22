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

async function main() {
  unitTraces();
  const args = process.argv.slice(2);
  if (args.includes("--compare")) {
    const i = args.indexOf("--agent");
    await compareLive(i >= 0 ? args[i + 1]?.toUpperCase() : undefined);
  }
  console.log(failures === 0 ? "\nALL UNIT TRACES PASSED" : `\n${failures} UNIT TRACE(S) FAILED`);
  if (failures > 0) process.exitCode = 1;
}

main().finally(() => prisma.$disconnect());
