// Canonical instrument-name → Instrument.code resolver. Broker ledgers,
// the fund-subscription CSV, and the source workbook all spell tickers
// differently ("BANK ASIA", "Sold AOPLC", "APSCL", "EKUSHSTABLERF", …);
// this normalises them to the seeded Instrument.code so reconciliation
// can match on a stable key. Returns null for anything unknown so the
// review step can surface it instead of silently dropping a trade.

/** Raw (trimmed, UPPER-cased, verb-stripped) ledger string → Instrument.code. */
export const TICKER_REMAP: Record<string, string> = {
  // workbook / broker spelling variants
  "AOPLC(PLACEMENTS)": "AOPLC_P",
  "AOPLC (PLACEMENT)": "AOPLC_P",
  AOPLC: "AOPLC_P", // the only AOPLC position the AMC holds is the placement
  "BANK ASIA": "BANKASIA",
  "PRIME BANK": "PRIMEBANK",
  "JAMUNA BANK": "JAMUNABANK",
  "BRAC BANK": "BRACBANK",
  "ASIATIC LABORATORIES": "ASIATICLAB",
  "ASIATIC LABORATORIES LIMITED": "ASIATICLAB",
  // bond / cable spellings
  BSCCL: "BSCPLC",
  "BANGLADESH SUBMARINE CABLE": "BSCPLC",
  "BANGLADESH SUBMARINE CABLE COMPANY PLC": "BSCPLC",
  APSCL: "APSCLBOND",
  APSCLBOND: "APSCLBOND",
  // own-fund unit spellings (fund CSV uses the codes directly)
  EKUSHFIRSTUF: "EFUF",
  EKUSHFIRSTUNITFUND: "EFUF",
  "EKUSH FIRST UNIT FUND": "EFUF",
  EKUSHGROWTH: "EGF",
  "EKUSH GROWTH FUND": "EGF",
  EKUSHSTABLERF: "ESRF",
  "EKUSH STABLE RETURN FUND": "ESRF",
};

/** Verbs broker ledgers prepend to the instrument in the Details column. */
const VERB_RE = /^(SOLD|BOUGHT|BUY|SELL|PURCHASE[D]?)\s+/i;

/**
 * Resolve a raw ledger instrument string to a known Instrument.code.
 * `knownCodes` is the live Instrument master — a raw token that already
 * IS a code (e.g. "BRACBANK") resolves to itself without a remap entry.
 */
export function resolveInstrumentCode(raw: string, knownCodes: Set<string>): string | null {
  if (!raw) return null;
  let s = raw.trim().toUpperCase().replace(VERB_RE, "").trim();
  // collapse internal whitespace
  s = s.replace(/\s+/g, " ");
  if (knownCodes.has(s)) return s;
  const noSpace = s.replace(/\s+/g, "");
  if (knownCodes.has(noSpace)) return noSpace;
  if (TICKER_REMAP[s]) return TICKER_REMAP[s];
  if (TICKER_REMAP[noSpace]) return TICKER_REMAP[noSpace];
  return null;
}
