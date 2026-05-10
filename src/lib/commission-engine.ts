// Commission engine — implements Selling Agent Agreement clause 6.
// Pure functions: take inputs, return CommissionRun-shaped objects.
// The caller persists; idempotency comes from the unique constraint on
// (agent_investor_id, type, period_start, period_end) in the schema.

import { categoryForFund, type EkushWebInvestor, type FundCode } from "@/lib/ekush-web/types";

export type AgentTermSnapshot = {
  fundCategory: "equity" | "fixed_income";
  upfrontPct: number;
  trailY1PctPa: number;
  trailY2PlusPctPa: number;
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

function isWithin(d: Date, start: Date, end: Date): boolean {
  return d >= start && d <= end;
}

/** ISO YYYY-MM-DD parser that returns a UTC midnight Date. */
function parseDate(s: string): Date {
  return new Date(`${s}T00:00:00.000Z`);
}

// ─── 8.1 Upfront ─────────────────────────────────────────────────

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

// ─── 8.2 Quarterly trail ─────────────────────────────────────────
// Weekly average held value × annualised rate ÷ 4. Y1 vs Y2+ chosen
// by quarter midpoint relative to sourced_on + 12 months.

export type WeeklyNav = {
  /** Date of the snapshot (typically each Thursday). */
  date: Date;
  /** NAV per unit. */
  unitNav: number;
};

export function computeQuarterlyTrail(
  inv: EkushWebInvestor,
  terms: AgentTermSnapshot[],
  navByFund: Map<FundCode, WeeklyNav[]>,
  quarterStart: Date,
  quarterEnd: Date,
): ComputedCommission | null {
  if (inv.is_direct_subscription) return null;
  const sourcedOn = parseDate(inv.sourced_on);
  if (sourcedOn > quarterEnd) return null;

  const quarterMid = new Date((quarterStart.getTime() + quarterEnd.getTime()) / 2);
  const term = pickTerm(terms, categoryForFund(inv.fund_code), quarterMid);
  if (!term) return null;

  const ratePa =
    quarterMid < addMonths(sourcedOn, 12) ? term.trailY1PctPa : term.trailY2PlusPctPa;
  const rateQuarter = ratePa / 4;

  const navs = (navByFund.get(inv.fund_code) ?? [])
    .filter((n) => isWithin(n.date, quarterStart, quarterEnd))
    .sort((a, b) => +a.date - +b.date);
  if (navs.length === 0) return null;

  // Units outstanding "as of week" = initial − redemptions before that week.
  // Per clause 6.3, redeemed units stop earning trail from redemption date.
  const redemptions = inv.redemptions
    .map((r) => ({ date: parseDate(r.date), units: r.units }))
    .sort((a, b) => +a.date - +b.date);

  const unitsAt = (asOf: Date): number => {
    let units = inv.initial_units;
    for (const r of redemptions) {
      if (r.date <= asOf) units -= r.units;
    }
    return Math.max(0, units);
  };

  const weeklyValues = navs.map((n) => unitsAt(n.date) * n.unitNav);
  const weeklyAvgValue = weeklyValues.reduce((s, v) => s + v, 0) / weeklyValues.length;
  if (weeklyAvgValue <= 0) return null;

  return {
    type: "trail",
    periodStart: quarterStart,
    periodEnd: quarterEnd,
    baseAmount: round2(weeklyAvgValue),
    rateApplied: rateQuarter,
    amount: round2(weeklyAvgValue * rateQuarter),
    notes: `${navs.length} weekly NAV snapshots, ${ratePa === term.trailY1PctPa ? "Y1" : "Y2+"} tier`,
  };
}

// ─── 8.3 Clawback on early redemption ────────────────────────────
// If any units redeemed within `clawbackMonths` of sourced_on, claw back
// `clawbackPct` of the upfront paid on the redeemed proportion.

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
