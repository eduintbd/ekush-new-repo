// Normalised shapes every ledger parser emits, plus small parse helpers.

export type LedgerSide = "BUY" | "SELL";

export type LedgerRow = {
  date: string; // YYYY-MM-DD
  rawInstrument: string;
  instrumentCode: string | null; // null = unresolved (review must fix)
  side: LedgerSide;
  quantity: number;
  rate: number;
  grossAmount: number;
  commission: number;
  source: string; // e.g. "UCB 3856", "Fund CSV A00003"
};

export type LedgerHolding = {
  rawInstrument: string;
  instrumentCode: string | null;
  quantity: number;
  avgCost: number;
  totalCost: number;
  source: string;
};

export type ParsedStatement = {
  profile: "ucb-prime" | "abaci" | "fund-csv" | "prime-portfolio" | "unknown";
  kind: "ledger" | "holding";
  source: string;
  rows: LedgerRow[];
  holdings: LedgerHolding[];
  warnings: string[];
};

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/** "07-Jul-2025" → "2025-07-07". Returns null if unparseable. */
export function parseDmy(s: string): string | null {
  const m = s.trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!m) return null;
  const mm = MONTHS[m[2].toLowerCase()];
  if (!mm) return null;
  return `${m[3]}-${mm}-${m[1].padStart(2, "0")}`;
}

/** "4/9/2026" (M/D/YYYY) → "2026-04-09". */
export function parseMdy(s: string): string | null {
  const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

/** "278,000.00" → 278000; tolerates parentheses/minus. */
export function num(s: string): number {
  const neg = /^\(.*\)$/.test(s.trim()) || s.trim().startsWith("-");
  const n = Number(s.replace(/[(),]/g, "").replace(/-/g, "").trim());
  return Number.isFinite(n) ? (neg ? -n : n) : NaN;
}
