// UCB Stock Brokerage + Prime Bank Securities "Investor Ledger Statement"
// (same rptViewer engine). When extracted with pdfjs/unpdf the rows come
// out as one stream with a consistent (but column-scrambled) per-row
// field order — and adjacent numerics are glued together:
//
//   Side Instrument Qty Amount<Date> Com Closing<Balance><Rate>
//   e.g.  BUY BRACBANK 5,000 278,000.0007-Jul-2025 556.00 -577,687.64-278,556.0055.6000
//
// We keep Operation ∈ {BUY, SELL}; Paid / Receipt / Change of Ownership /
// dividend rows don't match (no BUY/SELL token). Commission = the `Com`
// column (x-system capitalizes it), so cost reconciles to the fen.

import { resolveInstrumentCode } from "@/lib/ticker-remap";
import { type LedgerRow, type ParsedStatement, parseDmy, num } from "./types";

//   side    instrument        qty        amount        date              com          closing        balance        rate
const ROW =
  /(BUY|SELL)\s+([A-Z][A-Z0-9]*)\s+([\d,]+)\s+([\d,]+\.\d{2})\s*(\d{2}-[A-Za-z]{3}-\d{4})\s+([\d,]+\.\d{2})\s+-?[\d,]+\.\d{2}\s*-?[\d,]+\.\d{2}\s*([\d,]+\.\d{2,6})/g;

export function parseRptviewerLedger(text: string, knownCodes: Set<string>): ParsedStatement {
  const broker = /UCB Stock Brokerage/i.test(text)
    ? "UCB"
    : /Prime Bank Securities/i.test(text)
      ? "Prime"
      : "Broker";
  const acct = text.match(/Account (?:No|Name)\s*:?\s*(\d{3,})/i)?.[1] ?? "";
  const source = `${broker} ${acct}`.trim();

  const rows: LedgerRow[] = [];
  const warnings: string[] = [];
  for (const m of text.matchAll(ROW)) {
    const date = parseDmy(m[5]);
    if (!date) continue;
    const rawInstrument = m[2].trim();
    const code = resolveInstrumentCode(rawInstrument, knownCodes);
    if (!code) warnings.push(`Unresolved instrument "${rawInstrument}" on ${date}`);
    rows.push({
      date,
      rawInstrument,
      instrumentCode: code,
      side: m[1] as "BUY" | "SELL",
      quantity: num(m[3]),
      rate: num(m[7]),
      grossAmount: num(m[4]),
      commission: num(m[6]),
      source,
    });
  }
  if (rows.length === 0) warnings.push("No BUY/SELL rows matched — statement layout may differ.");
  return { profile: "ucb-prime", kind: "ledger", source, rows, holdings: [], warnings };
}
