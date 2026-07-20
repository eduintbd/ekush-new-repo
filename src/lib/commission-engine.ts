// Commission engine — implements Selling Agent Agreement clause 6.
// Pure functions: take inputs, return CommissionRun-shaped objects.
// The caller persists; idempotency comes from the unique constraint on
// (agent_investor_id, type, period_start, period_end) in the schema.

import { categoryForFund, type EkushWebInvestor } from "@/lib/ekush-web/types";

export type TrailFrequency = "monthly" | "quarterly";

/** Trail periods in a year for a given cadence — the annualised rate is
 *  divided by this to get the per-period rate. */
export function periodsPerYear(f: TrailFrequency): number {
  return f === "monthly" ? 12 : 4;
}

export type AgentTermSnapshot = {
  fundCategory: "equity" | "fixed_income";
  upfrontPct: number;
  trailY1PctPa: number;
  trailY2PlusPctPa: number;
  /** Cadence trail is paid on for this term. Admin-set; default monthly. */
  trailFrequency: TrailFrequency;
  clawbackMonths: number;
  clawbackPct: number;
  effectiveFrom: Date;
  effectiveTo: Date | null;
};

export type ComputedCommission = {
  type: "upfront" | "trail" | "clawback";
  periodStart: Date | null;
  periodEnd: Date | null;
  baseAmount: number;
  rateApplied: number;
  amount: number;
  notes?: string;
};

// ─── Helpers ─────────────────────────────────────────────────────

function pickTerm(
  terms: AgentTermSnapshot[],
  fundCategory: "equity" | "fixed_income",
  asOf: Date,
): AgentTermSnapshot | null {
  return (
    terms.find(
      (t) =>
        t.fundCategory === fundCategory &&
        t.effectiveFrom <= asOf &&
        (t.effectiveTo === null || t.effectiveTo > asOf),
    ) ?? null
  );
}

function addMonths(d: Date, months: number): Date {
  const n = new Date(d);
  n.setUTCMonth(n.getUTCMonth() + months);
  return n;
}


/** ISO YYYY-MM-DD parser that returns a UTC midnight Date. */
function parseDate(s: string): Date {
  return new Date(`${s}T00:00:00.000Z`);
}

// ─── 8.1 Upfront ─────────────────────────────────────────────────
// DEPRECATED: upfront is now the per-(agent,fund) high-water-mark model in
// src/lib/upfront-watermark.ts (+ /api/cron/monthly-upfront). This
// per-investor-at-sourcing calc is retained for reference/history only and
// has no live callers.

/** @deprecated Superseded by the watermark upfront model (upfront-watermark.ts). */
export function computeUpfront(
  inv: EkushWebInvestor,
  terms: AgentTermSnapshot[],
): ComputedCommission | null {
  if (inv.is_direct_subscription) return null; // clause 6.5
  const sourcedOn = parseDate(inv.sourced_on);
  const term = pickTerm(terms, categoryForFund(inv.fund_code), sourcedOn);
  if (!term) return null;
  const initialGross = inv.initial_units * inv.unit_price_at_sourcing;
  return {
    type: "upfront",
    periodStart: null,
    periodEnd: sourcedOn,
    baseAmount: round2(initialGross),
    rateApplied: term.upfrontPct,
    amount: round2(initialGross * term.upfrontPct),
  };
}

// ─── 8.2 Trail ───────────────────────────────────────────────────
// REMOVED (2026-07-20). `computeTrail` / `computeQuarterlyTrail` /
// `WeeklyNav` lived here and were driven by run-trail.ts off
// `xsystem.nav_snapshots` — a table with no writer anywhere in the repo, so
// they returned null for every investor and posted nothing, ever.
//
// Trail is now computed by `computeAgentCommissionPreview`
// (src/lib/agent-commission-preview.ts) and posted by `postTrailFromPreview`
// (src/lib/post-trail.ts), which the cron and the admin button both call. That
// engine reads the portal's populated `public.nav_records`, and derives units
// from actual BUY/SELL transactions rather than `initial_units − redemptions`
// — the old basis never added later purchases, so an investor who topped up
// earned trail on their first purchase forever.
//
// Anything here that survives (periodsPerYear, quartersFor, AgentTermSnapshot,
// TrailFrequency) is still imported by the preview and by run-upfront.ts.

// ─── 8.3 Clawback on early redemption ────────────────────────────
// If any units redeemed within `clawbackMonths` of sourced_on, claw back
// `clawbackPct` of the upfront paid on the redeemed proportion.

/** @deprecated N/A under the watermark upfront model — the watermark never
 *  falls, so paid upfront is retained on redemption. No live callers. */
export function computeClawbacks(
  inv: EkushWebInvestor,
  terms: AgentTermSnapshot[],
): ComputedCommission[] {
  if (inv.is_direct_subscription) return [];
  const sourcedOn = parseDate(inv.sourced_on);
  const term = pickTerm(terms, categoryForFund(inv.fund_code), sourcedOn);
  if (!term) return [];

  const upfrontAmount =
    inv.initial_units * inv.unit_price_at_sourcing * term.upfrontPct;
  const clawbackDeadline = addMonths(sourcedOn, term.clawbackMonths);

  const out: ComputedCommission[] = [];
  for (const r of inv.redemptions) {
    const redemptionDate = parseDate(r.date);
    if (redemptionDate > clawbackDeadline) continue;
    const ratio = r.units / inv.initial_units;
    const amount = -upfrontAmount * ratio * term.clawbackPct;
    out.push({
      type: "clawback",
      periodStart: sourcedOn,
      periodEnd: redemptionDate,
      baseAmount: round2(upfrontAmount * ratio),
      rateApplied: term.clawbackPct,
      amount: round2(amount),
      notes: `Redemption of ${r.units} units within ${term.clawbackMonths}-month window`,
    });
  }
  return out;
}

// ─── 8.4 Direct subscriptions ────────────────────────────────────
// Handled inline in each compute function above (early return).

// ─── Helper: fiscal-quarter math (Bangladesh FY = Jul–Jun) ───────

export type Quarter = { start: Date; end: Date; label: string };

export function quartersFor(fyStart: Date, fyEnd: Date): Quarter[] {
  const out: Quarter[] = [];
  const start = new Date(fyStart);
  start.setUTCDate(1);
  start.setUTCMonth(start.getUTCMonth());
  let qStart = new Date(start);
  while (qStart < fyEnd) {
    const qEnd = addMonths(qStart, 3);
    qEnd.setUTCDate(qEnd.getUTCDate() - 1);
    const cap = qEnd > fyEnd ? new Date(fyEnd) : qEnd;
    out.push({
      start: new Date(qStart),
      end: cap,
      label: `${qStart.toISOString().slice(0, 10)} → ${cap.toISOString().slice(0, 10)}`,
    });
    qStart = addMonths(qStart, 3);
  }
  return out;
}

// ─── ──────────────────────────────────────────────────────────── ─

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
