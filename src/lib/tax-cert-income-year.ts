// Canonical "income year" helpers for tax certificates. Shared by the investor
// portal page and the admin mail-send route so the email always matches exactly
// what the investor sees online (only the latest income year, all funds).
//
// Bangladesh income/fiscal year runs July → June. A certificate is labelled with
// the income year it COVERS (not the assessment year that follows): a period
// ending 30 Jun 2026 is "2025 - 26" (Jul 2025 → Jun 2026); one ending 30 Jun 2025
// is "2024 - 25".

export function getIncomeYear(periodEnd: Date | null): string {
  if (!periodEnd) return "N/A";
  const d = new Date(periodEnd);
  const endYear = d.getFullYear();
  const endMonth = d.getMonth(); // 0-indexed
  // Jan–Jun (month <= 5) → the calendar year N belongs to FY N-1/N.
  // Jul–Dec → FY N/N+1.
  if (endMonth <= 5) return `${endYear - 1} - ${String(endYear).slice(-2)}`;
  return `${endYear} - ${String(endYear + 1).slice(-2)}`;
}

// From an investor's certificates, keep only those whose income year equals the
// latest income year present. Mirrors the investor portal's Tax Certificate list:
// older years still exist in the data but are intentionally not surfaced/sent.
// Input order does not matter; the latest year is picked by income-year label.
export function latestIncomeYearCerts<T extends { periodEnd: Date | null }>(
  certs: T[],
): T[] {
  if (certs.length === 0) return [];
  const years = [...new Set(certs.map((c) => getIncomeYear(c.periodEnd)))];
  // Labels are "YYYY - YY", so a lexicographic descending sort is chronological.
  const latestYear = years.sort().reverse()[0] || "";
  return certs.filter((c) => getIncomeYear(c.periodEnd) === latestYear);
}

// A tax certificate is meaningful only if the investor had SOME position or
// activity in the fund during the period. An all-zero certificate (no units,
// no dividends, no tax, no purchases/redemptions) must never be shown to an
// investor or emailed — the operations rule is "no activity → no certificate".
// This mirrors the import parser's isEmpty skip; it's a defensive last line so
// a stray blank cert (e.g. from a bad backfill) can never surface a blank PDF.
const CERT_NUMERIC_FIELDS = [
  "beginningUnits", "beginningCostValue", "beginningMarketValue", "beginningUnrealizedGain",
  "endingUnits", "endingCostValue", "endingMarketValue", "endingUnrealizedGain",
  "totalUnitsAdded", "totalAdditionAtCost", "totalUnitsRedeemed", "totalRedemptionAtCost",
  "netInvestment", "totalRealizedGain", "totalGrossDividend", "totalTax", "totalNetDividend",
] as const;

export function certHasActivity(cert: Record<string, unknown>): boolean {
  // Prisma Decimal values coerce via Number() (as done throughout the mail route).
  return CERT_NUMERIC_FIELDS.some((k) => Number(cert[k] ?? 0) !== 0);
}
