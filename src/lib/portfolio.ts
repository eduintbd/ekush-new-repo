// Cost-basis engine. Pure functions over an ordered Trade stream — no DB
// writes, no I/O. The auto-journal generator (src/lib/trades.ts) calls
// `costBasisOnSell()` at the moment a SELL trade is being inserted to
// compute that trade's `costBasis` and `realisedPnl`. The portfolio
// page calls `buildPortfolioAsOf()` to render current holdings.
//
// Method: weighted-average per instrument. Matches the workbook's
// `Portfolio_Pinki_1` "Average Cost (Q.)" column. FIFO is not used.
//
//   on BUY:  newQty = qty + b.qty
//            newAvg = (qty * avg + b.qty * b.rate) / newQty
//   on SELL: costBasis = avg * s.qty
//            realisedPnl = s.grossAmount - costBasis
//            qty -= s.qty                   (avg unchanged)
//
// Short positions (selling more units than held) are an error — the
// caller must validate before invoking.

import type { Trade as PrismaTrade, Price as PrismaPrice } from "@/generated/prisma";

/** Minimal Trade shape this module needs — accepts both Prisma rows and
 *  the in-flight Trade being saved (which has no id yet). */
export type TradeLike = {
  tradeDate: Date;
  instrumentCode: string;
  side: "BUY" | "SELL";
  quantity: number | string | { toString: () => string };
  rate: number | string | { toString: () => string };
  grossAmount: number | string | { toString: () => string };
  /** Stable secondary sort to break ties on same-day trades. */
  createdAt?: Date;
};

export type PerInstrumentState = {
  quantity: number;
  /** Weighted-average cost per unit. Undefined when quantity = 0. */
  avgCost: number;
  /** Cumulative book cost of the position (= quantity * avgCost). */
  totalCost: number;
};

export type ReplayResult = {
  /** Per-instrument running state after applying every trade in `trades`. */
  byInstrument: Map<string, PerInstrumentState>;
  /** Total realised P&L across all sells in the input stream. Positive = gain. */
  realisedPnlTotal: number;
};

const num = (v: TradeLike["quantity"]): number => {
  if (typeof v === "number") return v;
  if (typeof v === "string") return Number(v);
  return Number(v.toString());
};

/**
 * Replay an ordered trade stream and yield per-instrument closing state.
 * Trades must already be sorted by (tradeDate ASC, createdAt ASC) — the
 * caller is responsible for ordering since it usually comes from a
 * Prisma query.
 */
export function replayTrades(trades: TradeLike[]): ReplayResult {
  const byInstrument = new Map<string, PerInstrumentState>();
  let realisedPnlTotal = 0;

  for (const t of trades) {
    const code = t.instrumentCode;
    const qty = num(t.quantity);
    const rate = num(t.rate);
    const gross = num(t.grossAmount);
    const prev = byInstrument.get(code) ?? { quantity: 0, avgCost: 0, totalCost: 0 };

    if (t.side === "BUY") {
      const newQty = prev.quantity + qty;
      const newTotalCost = prev.totalCost + qty * rate;
      // Guard division by zero — newQty can only be 0 if prev qty was negative
      // (a short) and the BUY closes it exactly. We don't support shorts, so
      // treat it as a reset.
      const newAvg = newQty > 0 ? newTotalCost / newQty : 0;
      byInstrument.set(code, {
        quantity: newQty,
        avgCost: newAvg,
        totalCost: newTotalCost,
      });
    } else {
      // SELL
      const costBasis = prev.avgCost * qty;
      const realisedPnl = gross - costBasis;
      realisedPnlTotal += realisedPnl;
      const newQty = prev.quantity - qty;
      byInstrument.set(code, {
        quantity: newQty,
        // Avg cost unchanged on sells (weighted-average method).
        avgCost: prev.avgCost,
        totalCost: prev.avgCost * newQty,
      });
    }
  }

  return { byInstrument, realisedPnlTotal };
}

/**
 * Compute the (costBasis, realisedPnl) snapshot for a SELL trade about
 * to be inserted, given the prior-trade history for the same instrument.
 * `priorTrades` MUST exclude the sell being computed.
 */
export function costBasisOnSell(
  priorTrades: TradeLike[],
  sell: { instrumentCode: string; quantity: number; grossAmount: number },
): { costBasis: number; realisedPnl: number; quantityAfter: number; avgCost: number } {
  const onlyThis = priorTrades.filter((t) => t.instrumentCode === sell.instrumentCode);
  const replay = replayTrades(onlyThis);
  const state = replay.byInstrument.get(sell.instrumentCode) ?? {
    quantity: 0,
    avgCost: 0,
    totalCost: 0,
  };
  const costBasis = state.avgCost * sell.quantity;
  return {
    costBasis,
    realisedPnl: sell.grossAmount - costBasis,
    quantityAfter: state.quantity - sell.quantity,
    avgCost: state.avgCost,
  };
}

/**
 * Build a portfolio view as of a given date. Returns one row per
 * instrument with quantity > 0 (active holdings) and joins the latest
 * Price row on or before `asOfDate` to compute market value + unrealised
 * G/L. Instruments with no price get `marketRate = null` and
 * unrealisedPnl = null.
 *
 * The caller passes the trade history (sorted) and the latest-price map.
 * This keeps the function pure (no DB calls).
 */
export type PortfolioRow = {
  instrumentCode: string;
  quantity: number;
  avgCost: number;
  totalCost: number;
  marketRate: number | null;
  marketValue: number | null;
  unrealisedPnl: number | null;
  /** Date of the price row used, if any. */
  priceDate: Date | null;
};

export function buildPortfolioAsOf(
  trades: TradeLike[],
  latestPrices: Map<string, { closePrice: number; priceDate: Date }>,
  /** Optional filter — only replay trades on or before this date. */
  asOfDate?: Date,
): PortfolioRow[] {
  const filtered = asOfDate ? trades.filter((t) => t.tradeDate <= asOfDate) : trades;
  const { byInstrument } = replayTrades(filtered);

  const rows: PortfolioRow[] = [];
  for (const [code, state] of byInstrument) {
    if (Math.abs(state.quantity) < 0.0001) continue; // closed positions
    const px = latestPrices.get(code);
    const marketValue = px ? state.quantity * px.closePrice : null;
    const unrealisedPnl = marketValue !== null ? marketValue - state.totalCost : null;
    rows.push({
      instrumentCode: code,
      quantity: state.quantity,
      avgCost: state.avgCost,
      totalCost: state.totalCost,
      marketRate: px ? px.closePrice : null,
      marketValue,
      unrealisedPnl,
      priceDate: px ? px.priceDate : null,
    });
  }
  rows.sort((a, b) => a.instrumentCode.localeCompare(b.instrumentCode));
  return rows;
}

/** Adapter that turns a Prisma `Trade[]` query result into TradeLike[]
 *  (Decimal → number coercion). */
export function fromPrismaTrades(rows: PrismaTrade[]): TradeLike[] {
  return rows.map((r) => ({
    tradeDate: r.tradeDate,
    instrumentCode: r.instrumentCode,
    side: r.side as "BUY" | "SELL",
    quantity: r.quantity.toString(),
    rate: r.rate.toString(),
    grossAmount: r.grossAmount.toString(),
    createdAt: r.createdAt,
  }));
}

/** Adapter that turns a Prisma `Price[]` query result into the
 *  latest-per-instrument map used by `buildPortfolioAsOf`. */
export function latestPricesMap(rows: PrismaPrice[]): Map<string, { closePrice: number; priceDate: Date }> {
  const map = new Map<string, { closePrice: number; priceDate: Date }>();
  for (const p of rows) {
    const existing = map.get(p.instrumentCode);
    if (!existing || p.priceDate > existing.priceDate) {
      map.set(p.instrumentCode, { closePrice: Number(p.closePrice), priceDate: p.priceDate });
    }
  }
  return map;
}
