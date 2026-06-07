// Fund-subscription ledger CSV (own-fund units EFUF/EGF/ESRF, placed
// off-market with the asset manager — they never appear on a broker PDF).
// Header: date,fund,direction,channel,amount,units,nav,status,payment_method,unique_code
// Only EXECUTED rows are real trades. The export occasionally carries a
// sign-flipped duplicate of the same trade (same units/nav, opposite
// amount sign, different unique_code) — we dedup on (date,fund,side,|units|,nav).

import { resolveInstrumentCode } from "@/lib/ticker-remap";
import { type LedgerRow, type ParsedStatement, parseMdy } from "./types";

export function parseFundCsv(text: string, knownCodes: Set<string>, label = ""): ParsedStatement {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const source = `Fund CSV ${label}`.trim();
  const rows: LedgerRow[] = [];
  const warnings: string[] = [];
  if (lines.length === 0) return { profile: "fund-csv", kind: "ledger", source, rows, holdings: [], warnings };

  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const ci = {
    date: col("date"),
    fund: col("fund"),
    direction: col("direction"),
    amount: col("amount"),
    units: col("units"),
    nav: col("nav"),
    status: col("status"),
    code: col("unique_code"),
  };

  const seen = new Set<string>();
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(",");
    if (ci.status >= 0 && (c[ci.status] ?? "").trim().toUpperCase() !== "EXECUTED") continue;
    const date = parseMdy(c[ci.date] ?? "");
    if (!date) continue;
    const rawInstrument = (c[ci.fund] ?? "").trim();
    const code = resolveInstrumentCode(rawInstrument, knownCodes);
    const side = (c[ci.direction] ?? "").trim().toUpperCase() === "SELL" ? "SELL" : "BUY";
    const quantity = Math.abs(Number(c[ci.units] ?? "0"));
    const rate = Math.abs(Number(c[ci.nav] ?? "0"));
    const grossAmount = Math.abs(Number(c[ci.amount] ?? "0"));
    if (!quantity || !rate) continue;
    const dedup = `${date}|${code ?? rawInstrument}|${side}|${quantity.toFixed(4)}|${rate.toFixed(6)}`;
    if (seen.has(dedup)) continue;
    seen.add(dedup);
    if (!code) warnings.push(`Unresolved fund "${rawInstrument}" on ${date}`);
    rows.push({ date, rawInstrument, instrumentCode: code, side, quantity, rate, grossAmount, commission: 0, source });
  }
  return { profile: "fund-csv", kind: "ledger", source, rows, holdings: [], warnings };
}
