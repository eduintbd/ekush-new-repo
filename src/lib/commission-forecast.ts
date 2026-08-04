// Pure commission forecast — safe to import on the client (no server deps).
//
// Given an investment amount, a tenor, a fund's CAGR and the agent's rates,
// project the commission the agent would earn:
//   - upfront: one-time, and ONLY on the part of the amount that lifts the
//              agent's book above its previous peak (see `bookShortfall`)
//   - trail:   every month, on the MARKET VALUE (which grows at the fund's
//              CAGR), at the Year-1 rate for the first 12 months and the
//              Year-2+ rate after that
//
// The CAGR is the fund's real annualised return from its NAV history, so this
// is "what it would have done over the last N years" and the forward forecast
// in one — same rate either way.

export interface ForecastInput {
  amount: number;
  tenorYears: number;
  /** Fund CAGR as a percent, e.g. 13.58. */
  cagrPct: number;
  /** Fractions, e.g. 0.001 for 0.10%. */
  upfrontRate: number;
  trailY1Rate: number;
  trailY2Rate: number;
  /**
   * How far the agent's book currently sits below its all-time peak. New money
   * only earns upfront above that line — below it, it is replacing money that
   * has already left and no new high is set. Defaults to 0 (book at its peak).
   */
  bookShortfall?: number;
}

export interface ForecastPoint {
  month: number;
  /** Projected market value of the holding that month. */
  value: number;
  /** Trail earned that month. */
  monthlyTrail: number;
  /** Upfront + all trail up to and including this month. */
  cumulativeCommission: number;
}

export interface ForecastResult {
  upfront: number;
  /** The shortfall that was applied — echoed back so the UI can explain a zero. */
  bookShortfall: number;
  /** The part of `amount` that actually earned upfront. */
  upfrontEligibleAmount: number;
  totalTrail: number;
  totalCommission: number;
  /** Fund value at the end of the tenor. */
  projectedValue: number;
  /** First month's trail — the "forecasted monthly commission". */
  firstMonthTrail: number;
  series: ForecastPoint[];
}

export function forecastCommission(input: ForecastInput): ForecastResult {
  const { amount, tenorYears, cagrPct, upfrontRate, trailY1Rate, trailY2Rate } = input;
  const months = Math.max(0, Math.round(tenorYears * 12));

  // Monthly growth that compounds to the annual CAGR.
  const monthlyGrowth = Math.pow(1 + cagrPct / 100, 1 / 12) - 1;

  // Upfront is paid on new money only — the amount by which the agent's whole
  // book rises above its previous peak. Money that merely refills a shortfall
  // left by earlier redemptions sets no new high and earns nothing, so it is
  // subtracted before the rate is applied.
  const bookShortfall = Math.max(0, input.bookShortfall ?? 0);
  const upfrontEligibleAmount = round2(Math.max(0, amount - bookShortfall));
  const upfront = round2(upfrontEligibleAmount * upfrontRate);

  const series: ForecastPoint[] = [
    { month: 0, value: round2(amount), monthlyTrail: 0, cumulativeCommission: upfront },
  ];

  let cumulative = upfront;
  let totalTrail = 0;
  let firstMonthTrail = 0;

  for (let m = 1; m <= months; m++) {
    const value = amount * Math.pow(1 + monthlyGrowth, m);
    const yearlyTrailRate = m <= 12 ? trailY1Rate : trailY2Rate;
    const monthlyTrail = value * (yearlyTrailRate / 12);
    totalTrail += monthlyTrail;
    cumulative += monthlyTrail;
    if (m === 1) firstMonthTrail = monthlyTrail;
    series.push({
      month: m,
      value: round2(value),
      monthlyTrail: round2(monthlyTrail),
      cumulativeCommission: round2(cumulative),
    });
  }

  const projectedValue = series.length ? series[series.length - 1].value : round2(amount);

  return {
    upfront,
    bookShortfall: round2(bookShortfall),
    upfrontEligibleAmount,
    totalTrail: round2(totalTrail),
    totalCommission: round2(upfront + totalTrail),
    projectedValue,
    firstMonthTrail: round2(firstMonthTrail),
    series,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Bangladeshi lakh grouping, no decimals unless asked. */
export function bdt(n: number, decimals = 0): string {
  return n.toLocaleString("en-IN", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}
