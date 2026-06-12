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
import { computeWatermarkUpfront } from "@/lib/upfront-watermark";

export type UpfrontWatermarkView = {
  fundCode: string;
  upfrontPct: number;
  /** Watermark already locked in (cumulative new money commissioned). */
  storedWatermark: number;
  /** All-time peak of net principal reached so far. */
  peak: number;
  /** Net principal right now (after redemptions). */
  currentNetPrincipal: number;
  /** New money above the stored watermark, not yet posted. */
  pendingIncrement: number;
  /** pendingIncrement × upfrontPct. */
  pendingUpfront: number;
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
  /** Per-fund high-water-mark upfront state (the live upfront model). */
  upfrontWatermarks: UpfrontWatermarkView[];
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
    include: { terms: true, investors: { orderBy: { sourcedOn: "asc" } } },
  });
  if (!agent) throw new Error(`Agent ${agentId} not found`);

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
  // Net invested principal (Σ BUY−SELL cash) per fund vs the stored
  // per-(agent,fund) watermark → pending new-money increment.
  const wmRows = await prisma.agentUpfrontWatermark.findMany({ where: { agentId } });
  const wmByFund = new Map(wmRows.map((w) => [w.fundCode, Number(w.watermark)]));
  const txByFund = new Map<string, { date: Date; direction: "BUY" | "SELL"; amount: number }[]>();
  for (const t of txns) {
    const arr = txByFund.get(t.fundCode) ?? [];
    arr.push({ date: t.date, direction: t.direction, amount: t.amount });
    txByFund.set(t.fundCode, arr);
  }
  const upfrontWatermarks: UpfrontWatermarkView[] = [];
  let pendingUpfront = 0;
  for (const [fundCode, ftx] of txByFund) {
    const term = termFor(termsActive, categoryForFund(fundCode as FundCode));
    const pct = term?.upfrontPct ?? 0;
    const stored = wmByFund.get(fundCode) ?? 0;
    const res = computeWatermarkUpfront(ftx, stored, pct);
    upfrontWatermarks.push({
      fundCode,
      upfrontPct: pct,
      storedWatermark: stored,
      peak: res.peak,
      currentNetPrincipal: res.netPrincipal,
      pendingIncrement: res.increment,
      pendingUpfront: res.upfront,
    });
    pendingUpfront += res.upfront;
  }
  upfrontWatermarks.sort((a, b) => a.fundCode.localeCompare(b.fundCode));
  const postedAgg = await prisma.commissionRun.aggregate({
    where: { agentId, type: "upfront" },
    _sum: { amount: true },
  });
  const postedUpfront = Number(postedAgg._sum.amount ?? 0);

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
    totals: {
      inflow: round2(totals.inflow),
      outflow: round2(totals.outflow),
      initialUpfront: round2(totals.initialUpfront),
      perInflowUpfront: round2(totals.perInflowUpfront),
      pendingUpfront: round2(pendingUpfront),
      postedUpfront: round2(postedUpfront),
      trail: round2(totals.trail),
      totalPayable: round2(pendingUpfront + totals.trail),
    },
  };
}
