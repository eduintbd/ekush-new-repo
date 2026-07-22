// Per-agent commission preview — pure server-side computation. Used by:
//   • /admin/agents/[id] page (renders totals + per-investor breakdown)
//   • /api/admin/agents/[id]/commissions/excel (returns workbook)
//   • scripts/calc-agent-commissions.ts (CLI workbook generator)
//   • postAgentCommissions server action (writes CommissionRun rows)
//
// Same engine in every place — admin sees in the UI exactly what the
// Excel and the posted CommissionRun rows reflect.

import type { PrismaClient } from "@/generated/prisma";
import { categoryForFund, type FundCode } from "@/lib/ekush-web/types";
import { periodsPerYear, type TrailFrequency } from "@/lib/commission-engine";
import {
  computeCombinedWatermarkUpfront,
  fetchAgentInvestorTxns,
  isUpfrontEntitled,
  type FetchWarning,
  type RateResolver,
} from "@/lib/upfront-watermark";

/** Where one investor's principal sits, and which fund's rate earned the
 *  pending increment. One leg per fund they hold under this agent. */
export type UpfrontWatermarkLeg = {
  fundCode: string;
  category: "equity" | "fixed_income";
  /** Net principal (Σ BUY−SELL, CIP excluded) in this fund. */
  netPrincipal: number;
  /** Share of this row's pendingIncrement attributed to this fund. */
  attributedIncrement: number;
  upfrontPct: number;
  attributedUpfront: number;
};

/** Combined-fund watermark state for ONE investor under this agent.
 *  Note there is no single `upfrontPct`: an investor spanning equity and
 *  fixed-income earns at two rates, so the rate lives on the legs and the row
 *  carries a blended figure for display. */
export type UpfrontWatermarkView = {
  investorCode: string;
  investorName: string;
  /** Watermark already locked in (cumulative new money commissioned). */
  storedWatermark: number;
  /** All-time peak of combined net principal reached so far. */
  peak: number;
  /** Combined net principal right now, all funds (after redemptions). */
  currentNetPrincipal: number;
  /** New money above the stored watermark, not yet posted. */
  pendingIncrement: number;
  /** Σ legs[].attributedUpfront. */
  pendingUpfront: number;
  /** pendingUpfront ÷ pendingIncrement; 0 when no increment. Display only. */
  blendedPct: number;
  /** Legs carry more than one distinct rate. */
  mixedRate: boolean;
  /** CIP dividend excluded from this investor's series. */
  cipOffset: number;
  /** Funds that drove a new high but have no active term — nothing posts. */
  unratedFunds: string[];
  legs: UpfrontWatermarkLeg[];
};

export type Term = {
  fundCategory: "equity" | "fixed_income";
  upfrontPct: number;
  trailY1PctPa: number;
  trailY2PlusPctPa: number;
  /** Cadence trail is paid on for this term (admin-set; default monthly). */
  trailFrequency: TrailFrequency;
  clawbackMonths: number;
  clawbackPct: number;
  effectiveFrom: Date;
  effectiveTo: Date | null;
};

export type Tx = {
  date: Date;
  investorCode: string;
  fundCode: FundCode;
  direction: "BUY" | "SELL";
  units: number;
  amount: number;
  nav: number | null;
  channel: string;
};

export type InvestorLink = {
  id: string;
  investorCode: string;
  fundCode: string;
  sourcedOn: Date;
  initialUnits: number;
  unitPriceAtSourcing: number;
  isDirectSubscription: boolean;
};

export type Bucket = {
  agentInvestorId: string;
  investorCode: string;
  name: string;
  fundCode: FundCode;
  category: "equity" | "fixed_income";
  sourcedOn: Date;
  isDirectSubscription: boolean;
  inflowTotal: number;
  outflowTotal: number;
  unitsBought: number;
  unitsSold: number;
  initialUpfront: number;
  perInflowUpfront: number;
  trailTotal: number;
  txCount: number;
  buys: Array<{ date: Date; units: number }>;
  sells: Array<{ date: Date; units: number }>;
  trailRows: TrailRow[];
};

export type TrailRow = {
  investorCode: string;
  fundCode: FundCode;
  agentInvestorId: string;
  /** Period bounds (a month or a quarter, per the term's cadence). Field
   *  names kept as quarter* for backward-compat with the page/Excel. */
  quarterStart: Date;
  quarterEnd: Date;
  qLabel: string;
  /** Cadence this row was computed on. */
  freq: TrailFrequency;
  sourcedOn: Date;
  tier: "Y1" | "Y2+";
  ratePa: number;
  /** Per-period rate (ratePa ÷ periodsPerYear). Name kept for compat. */
  rateQuarter: number;
  navPoints: number;
  avgUnits: number;
  avgNav: number;
  avgValue: number;
  trail: number;
  partial: boolean;
};

export type PreviewResult = {
  agentCode: string;
  agentName: string;
  agentStatus: string;
  asOf: Date;
  termsActive: Term[];
  termsAll: Term[];
  txns: Tx[];
  buckets: Bucket[];
  trailRows: TrailRow[];
  /** Per-INVESTOR combined-fund high-water-mark state (the live model). */
  upfrontWatermarks: UpfrontWatermarkView[];
  /** Data problems found while replaying — a human should look before posting. */
  upfrontWarnings: FetchWarning[];
  /** Accountant-controlled upfront entitlement (false = suspended). */
  upfrontEntitled: boolean;
  /** Date the active suspension took effect, if suspended. */
  upfrontSuspendedFrom: string | null;
  totals: {
    inflow: number;
    outflow: number;
    initialUpfront: number;
    perInflowUpfront: number;
    /** Watermark upfront not yet posted (Σ pendingUpfront). */
    pendingUpfront: number;
    /** Upfront already posted to CommissionRun (watermark + legacy). */
    postedUpfront: number;
    trail: number;
    totalPayable: number;
  };
};

export function addMonths(d: Date, months: number): Date {
  const n = new Date(d);
  n.setUTCMonth(n.getUTCMonth() + months);
  return n;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function termFor(terms: Term[], category: "equity" | "fixed_income"): Term | null {
  return terms.find((t) => t.fundCategory === category) ?? null;
}

/** Calendar periods (months or quarters) spanning [from, to], clamped at
 *  `to`. The step is 1 month for monthly, 3 for quarterly. */
function periodsFor(
  from: Date,
  to: Date,
  freq: TrailFrequency,
): Array<{ start: Date; end: Date; label: string }> {
  const out: Array<{ start: Date; end: Date; label: string }> = [];
  const step = freq === "monthly" ? 1 : 3;
  const startMonth = freq === "monthly"
    ? from.getUTCMonth()
    : Math.floor(from.getUTCMonth() / 3) * 3;
  let cur = new Date(Date.UTC(from.getUTCFullYear(), startMonth, 1));
  while (cur <= to) {
    const next = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + step, 1));
    const end = new Date(next.getTime() - 86400_000);
    const cap = end > to ? to : end;
    const tag = freq === "monthly" ? "M" : "Q";
    out.push({
      start: cur,
      end: cap,
      label: `${cur.toISOString().slice(0, 7)} ${tag} (${cur.toISOString().slice(0, 10)} → ${cap.toISOString().slice(0, 10)})`,
    });
    cur = next;
  }
  return out;
}

export async function computeAgentCommissionPreview(
  prisma: PrismaClient,
  agentId: string,
  asOf: Date = new Date(),
): Promise<PreviewResult> {
  const agent = await prisma.sellingAgent.findUnique({
    where: { id: agentId },
    include: { terms: true, investors: { orderBy: { sourcedOn: "asc" } }, upfrontSuspensions: true },
  });
  if (!agent) throw new Error(`Agent ${agentId} not found`);

  const upfrontEntitled = isUpfrontEntitled(agent.upfrontSuspensions, asOf);
  const activeSuspension = upfrontEntitled
    ? null
    : [...agent.upfrontSuspensions]
        .filter((e) => e.effectiveFrom <= asOf && e.action === "suspend")
        .sort((a, b) => +b.effectiveFrom - +a.effectiveFrom)[0] ?? null;
  const upfrontSuspendedFrom = activeSuspension ? activeSuspension.effectiveFrom.toISOString().slice(0, 10) : null;

  const termsAll: Term[] = agent.terms.map((t) => ({
    fundCategory: t.fundCategory as "equity" | "fixed_income",
    upfrontPct: Number(t.upfrontPct),
    trailY1PctPa: Number(t.trailY1PctPa),
    trailY2PlusPctPa: Number(t.trailY2PlusPctPa),
    trailFrequency: (t.trailFrequency === "monthly" ? "monthly" : "quarterly") as TrailFrequency,
    clawbackMonths: t.clawbackMonths,
    clawbackPct: Number(t.clawbackPct),
    effectiveFrom: t.effectiveFrom,
    effectiveTo: t.effectiveTo,
  }));

  // Latest effective term per category — applied retroactively (matches
  // the script + admin's stated intent: older rows with data-entry errors
  // are treated as superseded).
  const latestByCategory = new Map<"equity" | "fixed_income", Term>();
  for (const t of termsAll) {
    const cur = latestByCategory.get(t.fundCategory);
    if (!cur || t.effectiveFrom > cur.effectiveFrom) {
      latestByCategory.set(t.fundCategory, t);
    }
  }
  const termsActive = Array.from(latestByCategory.values());

  const investorCodes = Array.from(new Set(agent.investors.map((l) => l.investorCode)));
  if (investorCodes.length === 0) {
    return {
      agentCode: agent.code,
      agentName: agent.fullName,
      agentStatus: agent.status,
      asOf,
      termsActive,
      termsAll,
      txns: [],
      buckets: [],
      trailRows: [],
      upfrontWatermarks: [],
      upfrontWarnings: [],
      upfrontEntitled,
      upfrontSuspendedFrom,
      totals: {
        inflow: 0,
        outflow: 0,
        initialUpfront: 0,
        perInflowUpfront: 0,
        pendingUpfront: 0,
        postedUpfront: 0,
        trail: 0,
        totalPayable: 0,
      },
    };
  }

  const portalInvestors = await prisma.$queryRawUnsafe<
    Array<{ id: string; investorCode: string; name: string | null }>
  >(
    `SELECT id, "investorCode", name FROM public.investors WHERE "investorCode" = ANY($1::text[])`,
    investorCodes,
  );
  const portalFunds = await prisma.$queryRawUnsafe<Array<{ id: string; code: string }>>(
    `SELECT id, code FROM public.funds`,
  );
  const invIdByCode = new Map(portalInvestors.map((i) => [i.investorCode, i.id]));
  const invNameById = new Map(portalInvestors.map((i) => [i.id, i.name ?? ""]));
  const codeByInvId = new Map(portalInvestors.map((i) => [i.id, i.investorCode]));
  const codeByFundId = new Map(portalFunds.map((f) => [f.id, f.code]));

  const txnRows = await prisma.$queryRawUnsafe<
    Array<{
      investorId: string;
      fundId: string;
      date: Date;
      direction: string;
      units: unknown;
      amount: unknown;
      nav: unknown;
      channel: string;
    }>
  >(
    `SELECT "investorId", "fundId", "orderDate" AS date, direction, units, amount, nav, channel
     FROM public.transactions
     WHERE "investorId" = ANY($1::text[])
       AND "fundId" = ANY($2::text[])
       AND status = 'EXECUTED'
     ORDER BY "orderDate" ASC, "createdAt" ASC`,
    portalInvestors.map((i) => i.id),
    portalFunds.map((f) => f.id),
  );

  const linkByPair = new Map<string, InvestorLink>();
  for (const l of agent.investors) {
    linkByPair.set(`${l.investorCode}|${l.fundCode}`, {
      id: l.id,
      investorCode: l.investorCode,
      fundCode: l.fundCode,
      sourcedOn: l.sourcedOn,
      initialUnits: Number(l.initialUnits),
      unitPriceAtSourcing: Number(l.unitPriceAtSourcing),
      isDirectSubscription: l.isDirectSubscription,
    });
  }

  const txns: Tx[] = [];
  for (const t of txnRows) {
    const invCode = codeByInvId.get(t.investorId);
    const fundCode = codeByFundId.get(t.fundId);
    if (!invCode || !fundCode) continue;
    const link = linkByPair.get(`${invCode}|${fundCode}`);
    if (!link) continue;
    if (t.date < link.sourcedOn) continue;
    txns.push({
      date: t.date,
      investorCode: invCode,
      fundCode: fundCode as FundCode,
      direction: t.direction as "BUY" | "SELL",
      units: Number(t.units),
      amount: Number(t.amount ?? 0),
      nav: t.nav != null ? Number(t.nav) : null,
      channel: (t.channel as string) ?? "",
    });
  }

  const buckets = new Map<string, Bucket>();
  for (const t of txns) {
    const category = categoryForFund(t.fundCode);
    const term = termFor(termsActive, category);
    const rate = term?.upfrontPct ?? 0;
    const key = `${t.investorCode}|${t.fundCode}`;
    let b = buckets.get(key);
    if (!b) {
      const link = linkByPair.get(key)!;
      b = {
        agentInvestorId: link.id,
        investorCode: t.investorCode,
        name: invNameById.get(invIdByCode.get(t.investorCode) ?? "") ?? "",
        fundCode: t.fundCode,
        category,
        sourcedOn: link.sourcedOn,
        isDirectSubscription: link.isDirectSubscription,
        inflowTotal: 0,
        outflowTotal: 0,
        unitsBought: 0,
        unitsSold: 0,
        initialUpfront: 0,
        perInflowUpfront: 0,
        trailTotal: 0,
        txCount: 0,
        buys: [],
        sells: [],
        trailRows: [],
      };
      buckets.set(key, b);
    }
    b.txCount += 1;
    const isBuy = t.direction === "BUY";
    // Direct subscriptions earn no commission (clause 6.5).
    const commission = isBuy && !b.isDirectSubscription ? round2(t.amount * rate) : 0;
    if (isBuy) {
      b.inflowTotal += t.amount;
      b.unitsBought += t.units;
      b.perInflowUpfront += commission;
      b.buys.push({ date: t.date, units: t.units });
    } else {
      b.outflowTotal += t.amount;
      b.unitsSold += t.units;
      b.sells.push({ date: t.date, units: t.units });
    }
    // Per-spec initial upfront: only on the first BUY at sourcing date.
    const link = linkByPair.get(key)!;
    const isInitial =
      isBuy &&
      !b.isDirectSubscription &&
      t.date.toISOString().slice(0, 10) === link.sourcedOn.toISOString().slice(0, 10) &&
      b.initialUpfront === 0;
    if (isInitial) {
      const initialGross = link.initialUnits * link.unitPriceAtSourcing;
      b.initialUpfront = round2(initialGross * rate);
    }
  }

  const earliestSourced = Array.from(buckets.values()).reduce<Date | null>(
    (acc, b) => (acc === null || b.sourcedOn < acc ? b.sourcedOn : acc),
    null,
  );

  type NavRow = { fundCode: FundCode; date: Date; nav: number };
  let navRows: NavRow[] = [];
  if (earliestSourced) {
    const raw = await prisma.$queryRawUnsafe<
      Array<{ fund_code: string; date: Date; nav: unknown }>
    >(
      `SELECT f.code AS fund_code, n.date, n.nav
       FROM public.nav_records n
       JOIN public.funds f ON f.id = n."fundId"
       WHERE n.date >= $1
       ORDER BY n.date ASC`,
      earliestSourced,
    );
    navRows = raw.map((r) => ({
      fundCode: r.fund_code as FundCode,
      date: r.date,
      nav: Number(r.nav),
    }));
  }
  const navsByFund = new Map<FundCode, NavRow[]>();
  for (const n of navRows) {
    const arr = navsByFund.get(n.fundCode) ?? [];
    arr.push(n);
    navsByFund.set(n.fundCode, arr);
  }

  const trailRowsAll: TrailRow[] = [];
  if (earliestSourced) {
    // Generate both cadences once; each bucket uses the one its term is set
    // to (monthly preferred). periodsPerYear gives the rate divisor.
    const periodsByFreq: Record<TrailFrequency, Array<{ start: Date; end: Date; label: string }>> = {
      monthly: periodsFor(earliestSourced, asOf, "monthly"),
      quarterly: periodsFor(earliestSourced, asOf, "quarterly"),
    };
    for (const b of buckets.values()) {
      if (b.isDirectSubscription) continue;
      const term = termFor(termsActive, b.category);
      if (!term) continue;
      const freq = term.trailFrequency;
      const divisor = periodsPerYear(freq);
      const periods = periodsByFreq[freq];
      const buysSorted = [...b.buys].sort((x, y) => +x.date - +y.date);
      const sellsSorted = [...b.sells].sort((x, y) => +x.date - +y.date);
      const unitsAt = (d: Date): number => {
        let u = 0;
        for (const x of buysSorted) if (x.date <= d) u += x.units;
        for (const x of sellsSorted) if (x.date <= d) u -= x.units;
        return Math.max(0, u);
      };
      const navs = navsByFund.get(b.fundCode) ?? [];
      for (const q of periods) {
        if (q.end < b.sourcedOn) continue;
        const windowStart = q.start > b.sourcedOn ? q.start : b.sourcedOn;
        const qNavs = navs
          .filter((n) => n.date >= windowStart && n.date <= q.end)
          .sort((a, c) => +a.date - +c.date);
        if (qNavs.length === 0) continue;
        const midpoint = new Date((q.start.getTime() + q.end.getTime()) / 2);
        const isY1 = midpoint < addMonths(b.sourcedOn, 12);
        const ratePa = isY1 ? term.trailY1PctPa : term.trailY2PlusPctPa;
        const rateQuarter = ratePa / divisor;
        const values = qNavs.map((n) => ({
          u: unitsAt(n.date),
          v: n.nav,
          val: unitsAt(n.date) * n.nav,
        }));
        const avgValue = values.reduce((s, x) => s + x.val, 0) / values.length;
        if (avgValue <= 0) continue;
        const avgUnits = values.reduce((s, x) => s + x.u, 0) / values.length;
        const avgNav = values.reduce((s, x) => s + x.v, 0) / values.length;
        const trail = round2(avgValue * rateQuarter);
        b.trailTotal += trail;
        const row: TrailRow = {
          investorCode: b.investorCode,
          fundCode: b.fundCode,
          agentInvestorId: b.agentInvestorId,
          quarterStart: q.start,
          quarterEnd: q.end,
          qLabel: q.label,
          freq,
          sourcedOn: b.sourcedOn,
          tier: isY1 ? "Y1" : "Y2+",
          ratePa,
          rateQuarter,
          navPoints: values.length,
          avgUnits,
          avgNav,
          avgValue,
          trail,
          partial: q.end >= asOf,
        };
        b.trailRows.push(row);
        trailRowsAll.push(row);
      }
    }
  }

  const bucketsSorted = Array.from(buckets.values()).sort(
    (a, b) =>
      a.investorCode.localeCompare(b.investorCode) || a.fundCode.localeCompare(b.fundCode),
  );

  const totals = bucketsSorted.reduce(
    (acc, b) => ({
      inflow: acc.inflow + b.inflowTotal,
      outflow: acc.outflow + b.outflowTotal,
      initialUpfront: acc.initialUpfront + b.initialUpfront,
      perInflowUpfront: acc.perInflowUpfront + b.perInflowUpfront,
      trail: acc.trail + b.trailTotal,
    }),
    { inflow: 0, outflow: 0, initialUpfront: 0, perInflowUpfront: 0, trail: 0 },
  );

  // ── Watermark upfront (the live upfront model) ──────────────────
  // Combined across ALL funds, per INVESTOR, vs that investor's stored
  // watermark → pending new-money increment. Calls the SAME functions the
  // runner posts from, so what the accountant approves on this screen is
  // exactly what gets written. This block used to re-implement the fetch and
  // omitted both the isDirectSubscription filter and any as-of bound, so it
  // could overstate what would actually post — next to the Post button.
  const wmRows = await prisma.agentInvestorWatermark.findMany({ where: { agentId } });
  const wmByInvestor = new Map(wmRows.map((w) => [w.investorCode, Number(w.watermark)]));
  const nameByCode = new Map(bucketsSorted.map((b) => [b.investorCode, b.name]));

  const rateFor: RateResolver = (fundCode: string) => {
    const category = categoryForFund(fundCode as FundCode);
    const term = termFor(termsActive, category);
    return term ? { rate: term.upfrontPct, category } : null;
  };

  const { byInvestor: wmTxByInvestor, warnings: wmWarnings } = await fetchAgentInvestorTxns(
    prisma,
    agentId,
    asOf,
  );

  const upfrontWatermarks: UpfrontWatermarkView[] = [];
  let pendingUpfront = 0;
  for (const [investorCode, itx] of wmTxByInvestor) {
    const stored = wmByInvestor.get(investorCode) ?? 0;
    let res;
    try {
      res = computeCombinedWatermarkUpfront(itx, stored, rateFor);
    } catch {
      continue; // attribution mismatch — the runner blocks it too
    }
    // Net principal per fund, so the row can show WHERE the money sits.
    const netByFund = new Map<string, number>();
    for (const t of itx) {
      netByFund.set(
        t.fundCode,
        (netByFund.get(t.fundCode) ?? 0) + (t.direction === "BUY" ? t.amount : -t.amount),
      );
    }
    const legFunds = Array.from(new Set([...netByFund.keys(), ...res.slices.map((s) => s.fundCode)])).sort();
    const legs = legFunds.map((fundCode) => {
      const slice = res.slices.find((s) => s.fundCode === fundCode);
      const resolved = rateFor(fundCode);
      return {
        fundCode,
        category: resolved?.category ?? categoryForFund(fundCode as FundCode),
        netPrincipal: round2(netByFund.get(fundCode) ?? 0),
        attributedIncrement: slice?.base ?? 0,
        upfrontPct: slice?.rate ?? resolved?.rate ?? 0,
        attributedUpfront: slice?.upfront ?? 0,
      };
    });
    const rates = new Set(res.slices.map((s) => s.rate));
    upfrontWatermarks.push({
      investorCode,
      investorName: nameByCode.get(investorCode) ?? "",
      storedWatermark: stored,
      peak: res.peak,
      currentNetPrincipal: res.netPrincipal,
      pendingIncrement: res.increment,
      pendingUpfront: res.upfront,
      blendedPct: res.increment > 0 ? res.upfront / res.increment : 0,
      mixedRate: rates.size > 1,
      cipOffset: res.cipOffset,
      unratedFunds: res.unratedFunds,
      legs,
    });
    pendingUpfront += res.upfront;
  }
  upfrontWatermarks.sort((a, b) => a.investorCode.localeCompare(b.investorCode));
  const upfrontWarnings = wmWarnings;

  const postedAgg = await prisma.commissionRun.aggregate({
    where: { agentId, type: "upfront" },
    _sum: { amount: true },
  });
  const postedUpfront = Number(postedAgg._sum.amount ?? 0);

  // Suspended agents earn no upfront — the pending increment is forfeited
  // (the watermark stays put; accountant resets it at re-instatement).
  const effPendingUpfront = upfrontEntitled ? pendingUpfront : 0;

  return {
    agentCode: agent.code,
    agentName: agent.fullName,
    agentStatus: agent.status,
    asOf,
    termsActive,
    termsAll,
    txns,
    buckets: bucketsSorted,
    trailRows: trailRowsAll,
    upfrontWatermarks,
    upfrontWarnings,
    upfrontEntitled,
    upfrontSuspendedFrom,
    totals: {
      inflow: round2(totals.inflow),
      outflow: round2(totals.outflow),
      initialUpfront: round2(totals.initialUpfront),
      perInflowUpfront: round2(totals.perInflowUpfront),
      pendingUpfront: round2(effPendingUpfront),
      postedUpfront: round2(postedUpfront),
      trail: round2(totals.trail),
      totalPayable: round2(effPendingUpfront + totals.trail),
    },
  };
}
