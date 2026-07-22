// Agent upfront commission — combined-fund high-water-mark (HWM) engine.
//
// Upfront is paid only on the increment of an INVESTOR's net invested
// principal, under one agent, ACROSS ALL THREE FUNDS, above its prior peak.
// The peak (watermark) ratchets up and never falls when the client redeems —
// money that merely refills below the peak earns nothing; only new money above
// it does. NAV moves never matter (this is principal, not market value).
//
//   netPrincipal(investor, T) = Σ over EFUF+EGF+ESRF, for executed txns
//                               on/after that (investor, fund) pair's
//                               sourced_on through T, of (BUY − SELL) cash,
//                               EXCLUDING CIP dividend reinvestment
//   peak         = running maximum of netPrincipal
//   increment    = max(0, peak − storedWatermark)
//   upfront      = increment × the upfront % of the fund that RECEIVED the
//                  money which set the new high
//   newWatermark = max(storedWatermark, peak)
//
// WHY COMBINED (2026-07): the watermark used to be per (agent, fund). An
// investor could redeem 200,000 from ESRF and subscribe 250,000 to EFUF, and
// because each fund kept its own peak the agent was paid upfront on the whole
// 250,000 — twice on the same money. Combined, the SELL and the BUY cancel in
// one series, so only the genuine 50,000 is new. This needs no switch
// detection, which matters because the portal records a switch as an ordinary
// SELL and an ordinary BUY with nothing linking them.
//
// Investors are independent of one another: one client's redemption must never
// cancel out another client's genuinely new money.
//
// Idempotent: re-running a period finds peak ≤ watermark → increment 0.

import type { PrismaClient } from "@/generated/prisma";

/**
 * Which dividend figure was ploughed back as a purchase under CIP. The
 * portal's own tax certificate nets GROSS out of additions-at-cost to recover
 * real cash additions, so gross is the default. Changing this changes what
 * agents are paid — re-confirm with the AMC before touching it.
 */
export const CIP_BASIS: "gross" | "net" = "gross";

export type WmTxn = {
  date: Date;
  direction: "BUY" | "SELL";
  amount: number;
  /** Fund this movement belongs to — drives rate attribution. */
  fundCode: string;
  /** 'txn' = real portal transaction; 'cip' = synthetic dividend-reinvestment
   *  offset. CIP rows are always SELL-direction. */
  source: "txn" | "cip";
};

export type FetchWarning = {
  kind:
    | "unknown_direction"
    | "same_day_buy_sell"
    | "cip_no_candidate_buy"
    | "direct_mixed";
  investorCode: string;
  fundCode: string | null;
  detail: string;
};

export type AgentTxnSet = {
  /** investorCode → movements across ALL funds (unordered; replay sorts). */
  byInvestor: Map<string, WmTxn[]>;
  /** Non-empty means a human must look before anything posts. */
  warnings: FetchWarning[];
  /** Σ CIP dividend excluded, for the diagnostic header. */
  cipOffsetTotal: number;
};

export type FundCategory = "equity" | "fixed_income";

/** Resolves a fund's upfront rate. Returns null when no term covers it. */
export type RateResolver = (
  fundCode: string,
) => { rate: number; category: FundCategory } | null;

export type UpfrontSlice = {
  fundCode: string;
  category: FundCategory;
  /** New money attributed to this fund. */
  base: number;
  rate: number;
  upfront: number;
};

export type CombinedWatermarkResult = {
  peak: number;
  netPrincipal: number;
  increment: number;
  upfront: number;
  newWatermark: number;
  txCount: number;
  /** Aggregated by fundCode; empty when increment is 0. */
  slices: UpfrontSlice[];
  /** Funds that drove a new high but have no active term. Non-empty ⇒ the
   *  caller MUST post nothing and MUST NOT advance the watermark. */
  unratedFunds: string[];
  /** True if the replay ever went below zero — a SELL with no matching
   *  in-window BUY, usually a sourcedOn gate dropping an older purchase. */
  negativeRunningSeen: boolean;
  /** Σ CIP dividend excluded from this series. */
  cipOffset: number;
};

const r2 = (n: number) => Math.round(n * 100) / 100;
const iso = (d: Date) => new Date(d).toISOString().slice(0, 10);

export type SuspensionEvent = { action: string; effectiveFrom: Date; createdAt?: Date };

/** Is upfront entitled for the agent as of `asOf`? Entitlement = the latest
 *  event with effectiveFrom ≤ asOf is NOT a 'suspend' (no events = entitled).
 *  Supports repeated suspend/reinstate cycles. Agent-level; unaffected by the
 *  per-fund → per-investor change. */
export function isUpfrontEntitled(events: SuspensionEvent[], asOf: Date): boolean {
  let latest: SuspensionEvent | null = null;
  for (const e of events) {
    if (e.effectiveFrom > asOf) continue;
    if (
      !latest ||
      e.effectiveFrom > latest.effectiveFrom ||
      (e.effectiveFrom.getTime() === latest.effectiveFrom.getTime() &&
        (e.createdAt?.getTime() ?? 0) >= (latest.createdAt?.getTime() ?? 0))
    ) {
      latest = e;
    }
  }
  return !latest || latest.action !== "suspend";
}

/**
 * Replay order: by date, then SELL before BUY within the same date.
 *
 * This is a POLICY, and it is load-bearing. A fund switch is normally a
 * same-day redeem-and-subscribe. Processing the BUY first would book the gross
 * subscription as a new high before the redemption pulled it back — paying
 * upfront on money that never left. On the AMC's own example that is 250,000
 * instead of 50,000, a 5× overpayment decided purely by sort order.
 *
 * SELL-first can only ever understate, never overstate, which is the correct
 * direction of error on a system with no clawback. Genuine same-day
 * deposit-plus-redemption is warned on so a human can grant an exception.
 */
export function orderForReplay(txns: WmTxn[]): WmTxn[] {
  const rank = (t: WmTxn) => (t.direction === "SELL" ? 0 : 1);
  return [...txns].sort((a, b) => +a.date - +b.date || rank(a) - rank(b));
}

/**
 * Pure: replay the investor's combined net principal, pay on any new high
 * above the stored watermark, and attribute each new high to the fund whose
 * purchase caused it.
 *
 * Attribution is unambiguous because only a BUY can raise `running` — so every
 * new high has exactly one responsible fund. An investor whose increment spans
 * equity and fixed-income therefore yields two slices at two rates.
 */
export function computeCombinedWatermarkUpfront(
  txns: WmTxn[],
  storedWatermark: number,
  rateFor: RateResolver,
): CombinedWatermarkResult {
  const sorted = orderForReplay(txns);
  const sliceByFund = new Map<string, { base: number; category: FundCategory; rate: number }>();
  const unrated = new Set<string>();

  let running = 0;
  let peak = 0; // floors at 0 by initialisation, as the per-fund engine did
  let negativeRunningSeen = false;
  let cipOffset = 0;

  for (const t of sorted) {
    if (t.source === "cip") cipOffset += t.amount;
    running += t.direction === "BUY" ? t.amount : -t.amount;
    if (running < 0) negativeRunningSeen = true;
    if (running <= peak) continue;

    // New high. Bill only the part above whatever has already been paid for.
    const from = Math.max(peak, storedWatermark);
    peak = running;
    const base = running - from;
    if (base <= 0) continue; // new high still below the stored watermark

    const resolved = rateFor(t.fundCode);
    if (!resolved) {
      unrated.add(t.fundCode);
      continue;
    }
    const cur = sliceByFund.get(t.fundCode);
    if (cur) cur.base += base;
    else sliceByFund.set(t.fundCode, { base, category: resolved.category, rate: resolved.rate });
  }

  const newWatermark = Math.max(storedWatermark, peak);
  const increment = r2(Math.max(0, newWatermark - storedWatermark));
  const slices: UpfrontSlice[] = [...sliceByFund.entries()]
    .map(([fundCode, s]) => ({
      fundCode,
      category: s.category,
      base: r2(s.base),
      rate: s.rate,
      upfront: r2(s.base * s.rate),
    }))
    .sort((a, b) => a.fundCode.localeCompare(b.fundCode));

  // Portal amounts are Float; hundreds of movements drift. If the attributed
  // bases stop reconciling to the increment, the attribution is wrong and we
  // must not pay on it.
  const attributed = slices.reduce((s, x) => s + x.base, 0);
  if (unrated.size === 0 && Math.abs(attributed - increment) > 0.01) {
    throw new Error(
      `watermark attribution mismatch: slices ${attributed.toFixed(2)} vs increment ${increment.toFixed(2)}`,
    );
  }

  return {
    peak: r2(peak),
    netPrincipal: r2(running),
    increment,
    upfront: r2(slices.reduce((s, x) => s + x.upfront, 0)),
    newWatermark: r2(newWatermark),
    txCount: sorted.length,
    slices,
    unratedFunds: [...unrated],
    negativeRunningSeen,
    cipOffset: r2(cipOffset),
  };
}

/**
 * Fetch one agent's executed transactions grouped by INVESTOR (across all
 * funds), each gated to on/after that (investor, fund) pair's sourced_on and
 * through `throughDate`, with CIP dividend reinvestment offset out.
 */
export async function fetchAgentInvestorTxns(
  prisma: PrismaClient,
  agentId: string,
  throughDate: Date,
  opts: { excludeCip?: boolean } = {},
): Promise<AgentTxnSet> {
  const excludeCip = opts.excludeCip !== false;
  const byInvestor = new Map<string, WmTxn[]>();
  const warnings: FetchWarning[] = [];
  let cipOffsetTotal = 0;

  const agent = await prisma.sellingAgent.findUnique({
    where: { id: agentId },
    include: { investors: true },
  });
  if (!agent || agent.investors.length === 0) return { byInvestor, warnings, cipOffsetTotal };

  const investorCodes = Array.from(new Set(agent.investors.map((l) => l.investorCode)));
  const portalInvestors = await prisma.$queryRawUnsafe<Array<{ id: string; investorCode: string }>>(
    `SELECT id, "investorCode" FROM public.investors WHERE "investorCode" = ANY($1::text[])`,
    investorCodes,
  );
  const portalFunds = await prisma.$queryRawUnsafe<Array<{ id: string; code: string }>>(
    `SELECT id, code FROM public.funds`,
  );
  const codeByInvId = new Map(portalInvestors.map((i) => [i.id, i.investorCode]));
  const codeByFundId = new Map(portalFunds.map((f) => [f.id, f.code]));
  const invIds = portalInvestors.map((i) => i.id);
  const fundIds = portalFunds.map((f) => f.id);
  if (invIds.length === 0 || fundIds.length === 0) return { byInvestor, warnings, cipOffsetTotal };

  // Earliest sourced_on per (investorCode, fundCode) — gates pre-sourcing txns.
  // Direct subscriptions earn no agent commission (clause 6.5), so a pair only
  // counts toward the watermark if it has at least one non-direct link.
  const sourcedByPair = new Map<string, Date>();
  const eligiblePairs = new Set<string>();
  const directPairs = new Set<string>();
  for (const l of agent.investors) {
    const key = `${l.investorCode}|${l.fundCode}`;
    const cur = sourcedByPair.get(key);
    if (!cur || l.sourcedOn < cur) sourcedByPair.set(key, l.sourcedOn);
    if (l.isDirectSubscription) directPairs.add(key);
    else eligiblePairs.add(key);
  }

  // An investor holding one fund directly and another through the agent: a
  // switch OUT of the direct fund has its SELL excluded, so the incoming money
  // reads as genuinely new and pays in full. Arguably correct under clause 6.5
  // (direct money was never commissioned) but it is the same churn shape, so a
  // human should rule on each one.
  for (const code of investorCodes) {
    const hasDirect = [...directPairs].some((k) => k.startsWith(`${code}|`));
    const hasSourced = [...eligiblePairs].some((k) => k.startsWith(`${code}|`));
    if (hasDirect && hasSourced) {
      warnings.push({
        kind: "direct_mixed",
        investorCode: code,
        fundCode: null,
        detail: "holds both direct-subscription and agent-sourced funds; a switch out of the direct fund reads as new money",
      });
    }
  }

  const rows = await prisma.$queryRawUnsafe<
    Array<{ investorId: string; fundId: string; date: Date; direction: string; amount: unknown }>
  >(
    `SELECT "investorId", "fundId", "orderDate" AS date, direction, amount
     FROM public.transactions
     WHERE "investorId" = ANY($1::text[]) AND "fundId" = ANY($2::text[])
       AND status = 'EXECUTED' AND "orderDate" <= $3
     ORDER BY "orderDate" ASC, "createdAt" ASC`,
    invIds,
    fundIds,
    throughDate,
  );

  const push = (invCode: string, t: WmTxn) => {
    const arr = byInvestor.get(invCode) ?? [];
    arr.push(t);
    byInvestor.set(invCode, arr);
  };

  for (const t of rows) {
    const invCode = codeByInvId.get(t.investorId);
    const fundCode = codeByFundId.get(t.fundId);
    if (!invCode || !fundCode) continue;
    const pairKey = `${invCode}|${fundCode}`;
    if (!eligiblePairs.has(pairKey)) continue; // not linked / direct subscription
    const sourcedOn = sourcedByPair.get(pairKey);
    if (!sourcedOn || t.date < sourcedOn) continue; // pre-sourcing

    // `direction` is an unconstrained String in the portal. Coercing anything
    // that isn't "BUY" to "SELL" (as this used to) turns an unexpected value
    // into a silent redemption — and now that SELLs cancel BUYs across funds,
    // that would suppress the investor's whole position. Skip and warn.
    if (t.direction !== "BUY" && t.direction !== "SELL") {
      warnings.push({
        kind: "unknown_direction",
        investorCode: invCode,
        fundCode,
        detail: `${iso(t.date)} amount ${String(t.amount)} direction '${t.direction}' — row skipped`,
      });
      continue;
    }
    push(invCode, {
      date: t.date,
      direction: t.direction,
      amount: Number(t.amount ?? 0),
      fundCode,
      source: "txn",
    });
  }

  if (excludeCip) {
    const divs = await prisma.$queryRawUnsafe<
      Array<{ investorId: string; fundCode: string; paymentDate: Date; gross: unknown; net: unknown }>
    >(
      `SELECT d."investorId", f.code AS "fundCode", d."paymentDate",
              d."grossDividend" AS gross, d."netDividend" AS net
         FROM public.dividends d
         JOIN public.funds f ON f.id = d."fundId"
        WHERE d."investorId" = ANY($1::text[]) AND d."fundId" = ANY($2::text[])
          AND d."dividendOption" = 'CIP'
          AND d."paymentDate" IS NOT NULL AND d."paymentDate" <= $3
        ORDER BY d."paymentDate" ASC`,
      invIds,
      fundIds,
      throughDate,
    );

    for (const d of divs) {
      const invCode = codeByInvId.get(d.investorId);
      if (!invCode) continue;
      const pairKey = `${invCode}|${d.fundCode}`;
      if (!eligiblePairs.has(pairKey)) continue;
      const sourcedOn = sourcedByPair.get(pairKey);
      if (!sourcedOn || d.paymentDate < sourcedOn) continue;

      const amount = Number((CIP_BASIS === "gross" ? d.gross : d.net) ?? 0);
      if (!(amount > 0)) continue;

      // A synthetic offsetting SELL on the payment date, rather than trying to
      // identify which BUY row was the reinvestment. Exact on the net-principal
      // series however the reinvestment was booked (same day, later, split, or
      // netted into a bigger purchase), deterministic, and if the reinvestment
      // was never booked as a BUY at all this UNDERSTATES — the only acceptable
      // direction of error when there is no clawback.
      const bought = (byInvestor.get(invCode) ?? []).some(
        (x) =>
          x.source === "txn" &&
          x.direction === "BUY" &&
          x.fundCode === d.fundCode &&
          Math.abs(+x.date - +d.paymentDate) <= 7 * 864e5,
      );
      if (!bought) {
        warnings.push({
          kind: "cip_no_candidate_buy",
          investorCode: invCode,
          fundCode: d.fundCode,
          detail: `CIP ${amount.toFixed(2)} on ${iso(d.paymentDate)} with no purchase within 7 days — offset applied anyway (understates)`,
        });
      }

      cipOffsetTotal += amount;
      push(invCode, {
        date: d.paymentDate,
        direction: "SELL",
        amount,
        fundCode: d.fundCode,
        source: "cip",
      });
    }
  }

  // Same-day BUY+SELL is the switch signature; it is also what the SELL-first
  // ordering policy acts on, so surface every one for review.
  for (const [invCode, txns] of byInvestor) {
    const byDay = new Map<string, Set<string>>();
    for (const t of txns) {
      if (t.source !== "txn") continue;
      const k = iso(t.date);
      const s = byDay.get(k) ?? new Set<string>();
      s.add(t.direction);
      byDay.set(k, s);
    }
    for (const [day, dirs] of byDay) {
      if (dirs.size > 1) {
        warnings.push({
          kind: "same_day_buy_sell",
          investorCode: invCode,
          fundCode: null,
          detail: `BUY and SELL both on ${day} — replayed SELL-first (see orderForReplay)`,
        });
      }
    }
  }

  return { byInvestor, warnings, cipOffsetTotal: r2(cipOffsetTotal) };
}

// ─── Legacy per-fund model ───────────────────────────────────────
// Retained ONLY so scripts/verify-combined-watermark.ts --compare can show the
// AMC the money difference between the old and new models. Not called by any
// production code path. Delete once the combined model is signed off, seeded
// and posted.

export type WatermarkResult = {
  peak: number;
  netPrincipal: number;
  increment: number;
  upfront: number;
  newWatermark: number;
  txCount: number;
};

/** @deprecated Legacy per-fund model — comparison reporting only. */
export function computeWatermarkUpfront(
  txns: Array<{ date: Date; direction: "BUY" | "SELL"; amount: number }>,
  storedWatermark: number,
  upfrontPct: number,
): WatermarkResult {
  const sorted = [...txns].sort((a, b) => +a.date - +b.date);
  let running = 0;
  let peak = 0;
  for (const t of sorted) {
    running += t.direction === "BUY" ? t.amount : -t.amount;
    if (running > peak) peak = running;
  }
  const newWatermark = Math.max(storedWatermark, peak);
  const increment = r2(Math.max(0, newWatermark - storedWatermark));
  return {
    peak: r2(peak),
    netPrincipal: r2(running),
    increment,
    upfront: r2(increment * upfrontPct),
    newWatermark: r2(newWatermark),
    txCount: sorted.length,
  };
}

/** @deprecated Legacy per-fund grouping — comparison reporting only. */
export async function fetchAgentFundTxns(
  prisma: PrismaClient,
  agentId: string,
  throughDate: Date,
): Promise<Map<string, WmTxn[]>> {
  const { byInvestor } = await fetchAgentInvestorTxns(prisma, agentId, throughDate, {
    excludeCip: false,
  });
  const out = new Map<string, WmTxn[]>();
  for (const txns of byInvestor.values()) {
    for (const t of txns) {
      const arr = out.get(t.fundCode) ?? [];
      arr.push(t);
      out.set(t.fundCode, arr);
    }
  }
  return out;
}
