// Detect the statement profile from its text/banner and dispatch to the
// right parser. PDF→text extraction happens in the caller (server action,
// via unpdf); CSV text is passed straight through.

import { type ParsedStatement } from "./types";
import { parseRptviewerLedger } from "./rptviewer-ledger";
import { parseAbaciLedger } from "./abaci-ledger";
import { parseFundCsv } from "./fund-csv";
import { parsePrimePortfolio } from "./prime-portfolio";

export * from "./types";

export function detectAndParse(text: string, filename: string, knownCodes: Set<string>): ParsedStatement {
  const lower = filename.toLowerCase();
  const head = text.slice(0, 400).toLowerCase();

  // CSV fund-subscription ledger
  if (lower.endsWith(".csv") || (head.includes("direction") && head.includes("units") && head.includes("nav"))) {
    const label = (filename.match(/([A-Z]\d{4,})/i)?.[1] ?? "").toUpperCase();
    return parseFundCsv(text, knownCodes, label);
  }
  if (/Abaci Investments/i.test(text)) return parseAbaciLedger(text, knownCodes);
  if (/Portfolio Statement/i.test(text)) return parsePrimePortfolio(text, knownCodes);
  if (/Investor Ledger Statement/i.test(text) && /(UCB Stock Brokerage|Prime Bank Securities)/i.test(text)) {
    return parseRptviewerLedger(text, knownCodes);
  }
  return {
    profile: "unknown",
    kind: "ledger",
    source: filename,
    rows: [],
    holdings: [],
    warnings: [`Could not detect a known statement format in "${filename}".`],
  };
}
