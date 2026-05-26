// Tax-rate lookup helpers. The `tax_rates` table replaces the
// hard-coded 0.15 / 0.20 / 0.15 constants previously inlined in
// statement_mapping.ts. Each row carries an `effectiveFrom` date, so
// historical reporting periods recompute with the rate that was
// statutory at the time — not whatever happens to be current today.
//
// Lookup semantics: the "effective rate" for a given asOfDate is the
// row with the largest effectiveFrom <= asOfDate. If no row matches
// (DB hasn't been seeded yet, or a future-dated effectiveFrom only),
// fall back to DEFAULT_RATES so the IS/BS keep working.

import { prisma } from "@/lib/prisma";

export type TaxRateType =
  | "CAPITAL_GAIN"
  | "DIVIDEND"
  | "INTEREST"
  | "DEFERRED"
  | "MGMT_FEE"
  | "CORPORATE";

/** BD statutory defaults at the time of writing — see
 *  Finance Act 2024 §82C / §54 / §49 references. The DB is the source
 *  of truth; these defaults only matter on a fresh install. */
export const DEFAULT_RATES: Record<TaxRateType, number> = {
  CAPITAL_GAIN: 0.15,
  DIVIDEND: 0.20,
  INTEREST: 0.10,
  DEFERRED: 0.15,
  // No statutory rate for management fee — it's withheld at source
  // (varies by client). Stored as 0 here and entered as an amount
  // on the admin card.
  MGMT_FEE: 0,
  // Corporate (business) income-tax rate on regular taxable income at
  // AY assessment. AMC mgmt-fee income, FDR interest above the §49
  // withheld floor, etc. flow through this rate. BD non-listed
  // company default: 27.5%; listed company: 22.5%.
  CORPORATE: 0.275,
};

export type TaxRates = Record<TaxRateType, number>;

/**
 * Single-rate lookup. Returns the rate effective on `asOfDate`.
 */
export async function getTaxRate(
  rateType: TaxRateType,
  asOfDate: Date = new Date(),
  jurisdiction: string = "BD",
): Promise<number> {
  const row = await prisma.taxRate
    .findFirst({
      where: {
        jurisdiction,
        rateType,
        effectiveFrom: { lte: asOfDate },
      },
      orderBy: { effectiveFrom: "desc" },
    })
    .catch(() => null);
  return row ? Number(row.value) : DEFAULT_RATES[rateType];
}

/**
 * Bulk lookup — all rates effective on `asOfDate`, in one query.
 * Used by statement_mapping so the IS doesn't need 4 sequential
 * `findFirst` calls per render.
 */
export async function getTaxRatesAt(
  asOfDate: Date = new Date(),
  jurisdiction: string = "BD",
): Promise<TaxRates> {
  const rows = await prisma.taxRate
    .findMany({
      where: { jurisdiction, effectiveFrom: { lte: asOfDate } },
      orderBy: [{ rateType: "asc" }, { effectiveFrom: "desc" }],
    })
    .catch(() => [] as Array<{ rateType: string; value: { toString(): string } }>);

  const byType = new Map<string, number>();
  for (const r of rows) {
    if (!byType.has(r.rateType)) byType.set(r.rateType, Number(r.value));
  }
  return {
    CAPITAL_GAIN: byType.get("CAPITAL_GAIN") ?? DEFAULT_RATES.CAPITAL_GAIN,
    DIVIDEND: byType.get("DIVIDEND") ?? DEFAULT_RATES.DIVIDEND,
    INTEREST: byType.get("INTEREST") ?? DEFAULT_RATES.INTEREST,
    DEFERRED: byType.get("DEFERRED") ?? DEFAULT_RATES.DEFERRED,
    MGMT_FEE: byType.get("MGMT_FEE") ?? DEFAULT_RATES.MGMT_FEE,
    CORPORATE: byType.get("CORPORATE") ?? DEFAULT_RATES.CORPORATE,
  };
}
