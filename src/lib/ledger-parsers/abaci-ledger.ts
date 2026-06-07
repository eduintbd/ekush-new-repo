// Abaci Investments "Investor Ledger Statement Summary" — Debit/Credit
// variant. Via pdfjs the rows come out column-scrambled + glued, in a
// consistent per-row order:
//
//   Side Sold|Bought Instrument Qty Debit Credit<Date> Balance<Rate>
//   e.g.  SELL Sold AOPLC 10,000 0.00 194,025.0005-Dec-2024 196,255.6219.4025
//
// SELL proceeds are in Credit, BUY cost in Debit. Per-trade commission is
// 0 (Abaci bills charges on separate "Paid …" rows).

import { resolveInstrumentCode } from "@/lib/ticker-remap";
import { type LedgerRow, type ParsedStatement, parseDmy, num } from "./types";

//   side       verb         instrument        qty        debit         credit        date              balance       rate
const ROW =
  /(BUY|SELL)\s+(?:Sold|Bought)\s+([A-Z][A-Z0-9]*)\s+([\d,]+)\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s*(\d{2}-[A-Za-z]{3}-\d{4})\s+[\d,]+\.\d{2}\s*([\d,]+\.\d{2,6})/g;

export function parseAbaciLedger(text: string, knownCodes: Set<string>): ParsedStatement {
  const acct = text.match(/Investor Code\s*:?\s*([A-Z]?\d{3,})/i)?.[1] ?? "";
  const source = `Abaci ${acct}`.trim();

  const rows: LedgerRow[] = [];
  const warnings: string[] = [];
  for (const m of text.matchAll(ROW)) {
    const date = parseDmy(m[6]);
    if (!date) continue;
    const side = m[1] as "BUY" | "SELL";
    const rawInstrument = m[2].trim();
    const code = resolveInstrumentCode(rawInstrument, knownCodes);
    if (!code) warnings.push(`Unresolved instrument "${rawInstrument}" on ${date}`);
    const debit = num(m[4]);
    const credit = num(m[5]);
    rows.push({
      date,
      rawInstrument,
      instrumentCode: code,
      side,
      quantity: num(m[3]),
      rate: num(m[7]),
      grossAmount: side === "SELL" ? credit || debit : debit || credit,
      commission: 0,
      source,
    });
  }
  if (rows.length === 0) warnings.push("No BUY/SELL rows matched in Abaci statement.");
  return { profile: "abaci", kind: "ledger", source, rows, holdings: [], warnings };
}
