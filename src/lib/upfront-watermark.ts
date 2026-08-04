// Agent upfront commission — book-level high-water-mark (HWM) engine.
//
// Upfront is paid only on the increment of an AGENT'S WHOLE BOOK of net
// invested principal — every investor they sourced, across all three funds —
// above its prior peak. The peak (watermark) ratchets up and never falls when
// a client redeems; money that merely refills below the peak earns nothing,
// only new money above it does. NAV moves never matter (this is principal, not
// market value).
//
//   netPrincipal(agent, T) = Σ over every sourced investor, over
//                            EFUF+EGF+ESRF, for executed txns on/after that
//                            (investor, fund) pair's sourced_on through T,
//                            of (BUY − SELL) cash, EXCLUDING CIP dividend
//                            reinvestment
//   peak         = running maximum of netPrincipal
//   increment    = max(0, peak − storedWatermark)
//   upfront      = increment × the upfront % of the fund that RECEIVED the
//                  money which set the new high
//   newWatermark = max(storedWatermark, peak)
//
// WHY COMBINED ACROSS FUNDS (2026-07): the watermark used to be per
// (agent, fund). An investor could redeem 200,000 from ESRF and subscribe
// 250,000 to EFUF, and because each fund kept its own peak the agent was paid
// upfront on the whole 250,000 — twice on the same money. Combined, the SELL
// and the BUY cancel in one series, so only the genuine 50,000 is new. This
// needs no switch detection, which matters because the portal records a switch
// as an ordinary SELL and an ordinary BUY with nothing linking them.
//
// WHY BOOK-LEVEL (2026-08): the same trick still worked one level up. Move
// money out of client A and into client B under the same agent and the
// per-investor model saw a brand-new high in B's series and paid in full,
// though nothing new reached Ekush. There is no related-party field anywhere
// in the portal, so that cannot be detected — A and B are indistinguishable
// from two strangers. Netting the whole book makes the arithmetic itself
// immune: money moving between an agent's own clients leaves the total
// unchanged, so there is no new high and nothing to pay. The AMC's own
// reconciliation workbook computes it this way.
//
//   This deliberately reverses the earlier rule that investors are independent
//   of one another. One client's redemption now DOES absorb another client's
//   subscription. That is the point, and it is also the cost: a genuinely new
//   client whose money arrives while another client is redeeming earns
//   nothing. A book peak is the peak of a sum and can never exceed the sum of
//   peaks, so this model pays the same or less than the old one, never more —
//   the correct direction of error on a system with no clawback.
//
// Idempotent: re-running a period finds peak ≤ watermark → increment 0.

import type { PrismaClient } from "@/generated/prisma";
import { categoryForFund, type FundCode } from "@/lib/ekush-web/types";

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
  /** Investor this movement belongs to. Carried on the movement (rather than
   *  implied by the map key) because the book-level replay mixes investors in
   *  one series, and every posted row still needs a real AgentInvestor link to
   *  hang off — see the slice key in computeCombinedWatermarkUpfront. */
  investorCode: string;
  /** 'txn' = real portal transaction; 'cip' = synthetic dividend-reinvestment
   *  offset. CIP rows are always SELL-direction. */
  source: "txn" | "cip";
};

export type FetchWarning = {
  kind:
    | "unknown_direction"
    | "same_day_buy_sell"
    | "cip_no_candidate_buy"
    | "direct_mixed"
    | "sign_contradicts_direction";
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
  /** Investor whose purchase set the new high this slice bills for. Keeping
   *  the investor on the slice is what lets run-upfront resolve a real
   *  AgentInvestor link for every posted row; without it agentInvestorId goes
   *  null, and null never collides in a Postgres unique index, so upfront
   *  would silently lose its DB-level idempotency. */
  investorCode: string;
  category: FundCategory;
  /** New money attributed to this investor × fund. */
  base: number;
  rate: number;
  upfront: number;
};

/** One movement of the replay, in the order the engine actually processed it.
 *  This is the audit trail an agent gets in their workbook: it shows why each
 *  subscription did or did not earn upfront, rather than asking them to take
 *  the total on faith. */
export type WatermarkStep = {
  date: Date;
  fundCode: string;
  /** Whose movement this is. The book replay interleaves investors, so the
   *  workbook has to name one on every row or the trace is unreadable. */
  investorCode: string;
  direction: "BUY" | "SELL";
  source: "txn" | "cip";
  /** Signed effect on net invested principal (see principalDelta). */
  delta: number;
  /** Net invested principal after this movement. */
  running: number;
  /** Peak after this movement — never falls. */
  peak: number;
  /** Part of this movement above everything already paid for. */
  newMoney: number;
  /** Rate applied to newMoney; 0 when nothing was earned. */
  rate: number;
  upfront: number;
  /** Plain-language reason, safe to show an agent. */
  note: string;
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
  /** The replay itself, one row per movement, in processed order. */
  trace: WatermarkStep[];
};

const r2 = (n: number) => Math.round(n * 100) / 100;
const iso = (d: Date) => new Date(d).toISOString().slice(0, 10);

/**
 * How much a movement changes net invested principal, as a SIGNED number.
 *
 * `public.transactions.amount` already carries the sign of the movement: every
 * executed SELL in the portal is stored NEGATIVE (1,866 of 1,868 rows as of
 * 2026-08). This engine used to do `BUY ? amount : -amount`, which negated an
 * already-negative redemption and so ADDED it to the series — a redemption
 * pushed the watermark UP and paid upfront on money going out the door. On
 * agent S00004 that reported A00699's net principal as 105,500,000 against a
 * true 42,500,000, and billed the redeemed money again on re-entry.
 *
 * So SELL is normalised on magnitude — `-|amount|` reduces principal under
 * either sign convention. BUY keeps its stored sign: the handful of negative
 * BUY rows are corrections/reversals, and taking their magnitude would turn a
 * reversal into a subscription. Both choices can only ever understate, which
 * is the correct direction of error on a system with no clawback.
 */
export function principalDelta(t: { direction: "BUY" | "SELL"; amount: number }): number {
  return t.direction === "BUY" ? t.amount : -Math.abs(t.amount);
}

/** The slice of an AgentTerm the upfront rate depends on. Structurally
 *  satisfied by both `run-upfront`'s query and the preview's `Term`. */
export type TermLite = {
  fundCategory: "equity" | "fixed_income";
  upfrontPct: number;
  effectiveFrom: Date;
  effectiveTo: Date | null;
};

/**
 * Upfront rate from the term in force for this fund's category AT `asOf`.
 *
 * Shared by the runner (`run-upfront.ts`), the preview (`agent-commission-
 * preview.ts`) and the agent calculator, deliberately: the preview used to
 * resolve the rate as "latest term, applied retroactively" while the runner
 * used "term in force at the period end". Those agree only while every category
 * has exactly one open term — add a term with a future `effectiveFrom` or close
 * one with an `effectiveTo` and the screen would quote a rate the posting run
 * would not use. One function means that can no longer happen.
 *
 * Ties on `effectiveFrom` resolve to the most recently starting row.
 */
export function makeRateResolver(terms: TermLite[], asOf: Date): RateResolver {
  return (fundCode: string) => {
    const category = categoryForFund(fundCode as FundCode);
    const active = terms
      .filter(
        (t) =>
          t.fundCategory === category &&
          t.effectiveFrom <= asOf &&
          (t.effectiveTo === null || t.effectiveTo > asOf),
      )
      .sort((a, b) => +b.effectiveFrom - +a.effectiveFrom);
    const t = active[0];
    return t ? { rate: t.upfrontPct, category } : null;
  };
}

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
 *
 * 2026-08: the code is unchanged but its reach is not. Under the book-level
 * replay this no longer only nets an investor against themselves — it nets one
 * client's redemption against a DIFFERENT client's subscription on the same
 * date. That is the cross-account churn defence working as intended rather
 * than an accident of sorting, and it is worth knowing that a change here now
 * moves money between clients, not just within one.
 */
export function orderForReplay(txns: WmTxn[]): WmTxn[] {
  const rank = (t: WmTxn) => (t.direction === "SELL" ? 0 : 1);
  return [...txns].sort((a, b) => +a.date - +b.date || rank(a) - rank(b));
}

/**
 * Every movement the agent sourced, as one series.
 *
 * `fetchAgentInvestorTxns` still returns a per-investor map, and must: the CIP
 * candidate-BUY lookup and the same-day BUY+SELL detection are only meaningful
 * within one investor's own history. The book replay is a view over that map,
 * not a replacement for it.
 */
export function flattenToAgentSeries(byInvestor: Map<string, WmTxn[]>): WmTxn[] {
  const out: WmTxn[] = [];
  for (const txns of byInvestor.values()) out.push(...txns);
  return out;
}

/**
 * Pure: replay net principal, pay on any new high above the stored watermark,
 * and attribute each new high to the investor × fund whose purchase caused it.
 *
 * Fed one investor's movements this is a per-investor watermark; fed
 * `flattenToAgentSeries(...)` it is the book-level one. The function does not
 * care — the caller decides the scope, and since 2026-08 every production
 * caller passes the whole book.
 *
 * Attribution is unambiguous because only a BUY can raise `running` — so every
 * new high has exactly one responsible movement, and therefore exactly one
 * investor and one fund. A book increment spanning equity and fixed-income, or
 * two investors, yields one slice per (investor, fund) at that fund's rate.
 */
export function computeCombinedWatermarkUpfront(
  txns: WmTxn[],
  storedWatermark: number,
  rateFor: RateResolver,
): CombinedWatermarkResult {
  const sorted = orderForReplay(txns);
  // Keyed by `investorCode|fundCode`, not fundCode: two investors buying into
  // the same fund must stay separate slices so each posted row keeps its own
  // AgentInvestor link.
  const sliceByKey = new Map<
    string,
    { investorCode: string; fundCode: string; base: number; category: FundCategory; rate: number }
  >();
  const unrated = new Set<string>();

  let running = 0;
  let peak = 0; // floors at 0 by initialisation, as the per-fund engine did
  let negativeRunningSeen = false;
  let cipOffset = 0;

  const trace: WatermarkStep[] = [];
  for (const t of sorted) {
    if (t.source === "cip") cipOffset += Math.abs(t.amount);
    const delta = principalDelta(t);
    running += delta;
    if (running < 0) negativeRunningSeen = true;

    let newMoney = 0;
    let rate = 0;
    let note: string;

    if (running <= peak) {
      // Under the book model a BUY below the peak is not necessarily the same
      // client's money coming back — it can be a brand-new client arriving
      // while someone else is redeeming. Saying "already commissioned" there
      // would be plainly wrong to the agent reading the workbook.
      note =
        t.source === "cip"
          ? "CIP reinvestment — not new money"
          : delta < 0
            ? "Redemption — the book's peak does not fall"
            : "Book still below its peak — this money replaces money that left, so no new high";
    } else {
      // New high. Bill only the part above whatever has already been paid for.
      const from = Math.max(peak, storedWatermark);
      peak = running;
      const base = running - from;
      if (base <= 0) {
        note = "New peak, but still below the watermark already paid on";
      } else {
        const resolved = rateFor(t.fundCode);
        if (!resolved) {
          unrated.add(t.fundCode);
          note = `No commission term covers ${t.fundCode} — nothing posts`;
        } else {
          newMoney = base;
          rate = resolved.rate;
          const key = `${t.investorCode}|${t.fundCode}`;
          const cur = sliceByKey.get(key);
          if (cur) cur.base += base;
          else
            sliceByKey.set(key, {
              investorCode: t.investorCode,
              fundCode: t.fundCode,
              base,
              category: resolved.category,
              rate: resolved.rate,
            });
          note =
            base < delta
              ? "New high — upfront on the part above the previous peak only"
              : "New high — upfront on the full amount";
        }
      }
    }

    trace.push({
      date: t.date,
      fundCode: t.fundCode,
      investorCode: t.investorCode,
      direction: t.direction,
      source: t.source,
      delta: r2(delta),
      running: r2(running),
      peak: r2(peak),
      newMoney: r2(newMoney),
      rate,
      upfront: r2(newMoney * rate),
      note,
    });
  }

  const newWatermark = Math.max(storedWatermark, peak);
  const increment = r2(Math.max(0, newWatermark - storedWatermark));
  const slices: UpfrontSlice[] = [...sliceByKey.values()]
    .map((s) => ({
      fundCode: s.fundCode,
      investorCode: s.investorCode,
      category: s.category,
      base: r2(s.base),
      rate: s.rate,
      upfront: r2(s.base * s.rate),
    }))
    .sort(
      (a, b) =>
        a.investorCode.localeCompare(b.investorCode) || a.fundCode.localeCompare(b.fundCode),
    );

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
    trace,
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
    // The portal signs SELL amounts negative. A row whose sign disagrees with
    // its direction is either a correction or a data-entry error, and
    // principalDelta() resolves it conservatively — say so out loud rather than
    // letting it move money silently.
    const amount = Number(t.amount ?? 0);
    if ((t.direction === "BUY" && amount < 0) || (t.direction === "SELL" && amount > 0)) {
      warnings.push({
        kind: "sign_contradicts_direction",
        investorCode: invCode,
        fundCode,
        detail: `${iso(t.date)} ${t.direction} amount ${amount.toFixed(2)} — sign disagrees with direction; treated as ${principalDelta({ direction: t.direction, amount }).toFixed(2)}`,
      });
    }
    push(invCode, {
      date: t.date,
      direction: t.direction,
      amount,
      fundCode,
      investorCode: invCode,
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
        investorCode: invCode,
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

export type BookShortfall = {
  /** Highest the book has ever been, or the watermark already paid on — whichever is higher. */
  peak: number;
  /** Where the book sits now, after redemptions. */
  netPrincipal: number;
  /**
   * How much new money must arrive before ANY of it earns upfront. Zero when
   * the book is at its peak.
   */
  shortfall: number;
};

/**
 * How far the agent's book is below the level upfront is next payable from.
 *
 * Exists for the commission calculator, which projected `amount × rate`
 * unconditionally and so told an agent sitting below their peak that bringing
 * ৳10,00,000 would earn them upfront when the true answer is nothing — that
 * money replaces money that has left. Cheaper than a full commission preview:
 * no NAV history, no trail periods, just the replay.
 */
export async function getAgentBookShortfall(
  prisma: PrismaClient,
  agentId: string,
  asOf: Date = new Date(),
): Promise<BookShortfall> {
  const [wmRow, { byInvestor }] = await Promise.all([
    prisma.agentBookWatermark.findUnique({ where: { agentId } }),
    fetchAgentInvestorTxns(prisma, agentId, asOf),
  ]);
  const stored = wmRow ? Number(wmRow.watermark) : 0;
  const txns = flattenToAgentSeries(byInvestor);
  if (txns.length === 0) {
    return { peak: stored, netPrincipal: 0, shortfall: r2(stored) };
  }
  // The rate is irrelevant here — only peak and net principal are read — so a
  // resolver that always answers keeps `unratedFunds` from suppressing them.
  const res = computeCombinedWatermarkUpfront(txns, stored, () => ({
    rate: 0,
    category: "equity",
  }));
  const from = Math.max(stored, res.peak);
  return {
    peak: r2(from),
    netPrincipal: r2(res.netPrincipal),
    shortfall: r2(Math.max(0, from - res.netPrincipal)),
  };
}

// The legacy per-fund model (`computeWatermarkUpfront` / `fetchAgentFundTxns`)
// lived here so the cutover script could show the AMC the money difference
// against the old model. The cutover is done and signed off, so both are gone —
// `computeCombinedWatermarkUpfront` above is the only upfront calculation in
// the system.
