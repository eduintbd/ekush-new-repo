// Prime Bank Securities "Portfolio Statement" — holdings snapshot (qty +
// avg cost per instrument as of the statement date), used for the
// holdings cross-check. Via pdfjs the rows are column-scrambled + glued,
// with the instrument NAME at the end:
//
//   TotalQty SaleableQty AvgCost MktRate<TotalCost> MktValue UnrealG<SN> %Gain %Mkt<Instrument> Group
//   e.g.  100,004 100,004 7.31 7.40731,488.56 740,029.60 8,541.041 1.17 5.08SEMLLECMF A

import { resolveInstrumentCode } from "@/lib/ticker-remap";
import { type LedgerHolding, type ParsedStatement, num } from "./types";

//   totalQty   saleableQty  avgCost     mktRate  totalCost      mktValue       unrealG+SN          %gain      %mkt   instrument        group
const ROW =
  /([\d,]+)\s+([\d,]+)\s+(\d+\.\d{2})\s+\d+\.\d{2}([\d,]+\.\d{2})\s+[\d,]+\.\d{2}\s+-?[\d,]+\.\d{2}\d+\s+-?[\d.]+\s+[\d.]+([A-Z][A-Z0-9]+)\s+[A-Z]\b/g;

export function parsePrimePortfolio(text: string, knownCodes: Set<string>): ParsedStatement {
  const acct = text.match(/Investor Code\s*:?[^0-9]*(\d{3,})/i)?.[1] ?? "";
  const asOf = text.match(/Date\s*:?\s*(\d{2}-[A-Za-z]{3}-\d{4})/)?.[1] ?? "";
  const source = `Prime Portfolio ${acct}${asOf ? ` @ ${asOf}` : ""}`.trim();

  const holdings: LedgerHolding[] = [];
  const warnings: string[] = [];
  for (const m of text.matchAll(ROW)) {
    const rawInstrument = m[5].trim();
    const code = resolveInstrumentCode(rawInstrument, knownCodes);
    if (!code) warnings.push(`Unresolved instrument "${rawInstrument}" in portfolio`);
    holdings.push({
      rawInstrument,
      instrumentCode: code,
      quantity: num(m[1]),
      avgCost: num(m[3]),
      totalCost: num(m[4]),
      source,
    });
  }
  if (holdings.length === 0) warnings.push("No holdings rows matched in portfolio statement.");
  return { profile: "prime-portfolio", kind: "holding", source, rows: [], holdings, warnings };
}
