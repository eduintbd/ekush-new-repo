/* eslint-disable */
// One-off backfill: read the workbook's `Trading Record ` sheet, create
// one Trade row per line, generate the matching journal voucher
// (BV/SV). Idempotent — re-running won't duplicate (we key dedup on
// `(tradeDate, instrumentCode, side, quantity, rate)`).
//
// Usage:
//   npx tsx scripts/import-workbook-trades.ts \
//     --xlsx="C:/Users/USER/OneDrive/Desktop/x-system_inputs/F.S March 2026_mock.xlsx" \
//     --from=2025-07-01 --to=2026-03-31 \
//     [--dry]
//
// Default range is FY2025-26 (Jul 1 → Mar 31 to match the user's scope).
// --dry prints what would be inserted without writing.

import { config } from "dotenv";
config({ path: ".env" });

import { randomUUID } from "node:crypto";
import path from "node:path";
import ExcelJS from "exceljs";
import { PrismaClient } from "@/generated/prisma";
import { allocateVoucherNo } from "@/lib/voucher";
import { costBasisOnSell, fromPrismaTrades } from "@/lib/portfolio";

const prisma = new PrismaClient();

const args = parseArgs(process.argv.slice(2));
const xlsxArg = typeof args.xlsx === "string" ? args.xlsx : "";
const fromArg = typeof args.from === "string" ? args.from : "";
const toArg = typeof args.to === "string" ? args.to : "";
const xlsxPath = xlsxArg || "C:/Users/USER/OneDrive/Desktop/x-system_inputs/F.S March 2026_mock.xlsx";
const fromDate = fromArg ? new Date(`${fromArg}T00:00:00Z`) : new Date("2025-07-01T00:00:00Z");
const toDate = toArg ? new Date(`${toArg}T00:00:00Z`) : new Date("2026-03-31T00:00:00Z");
const dryRun = Boolean(args.dry);
const SHEET = "Trading Record "; // trailing space — matches workbook

// Ticker remapping: the workbook uses some legacy / variant strings that
// don't match the seeded Instrument.code. Resolve them here so trades
// can land on the right Instrument FK.
const TICKER_REMAP: Record<string, string> = {
  "AOPLC(PLACEMENTS)": "AOPLC_P",
  "BANK ASIA": "BANKASIA",
  "PRIME BANK": "PRIMEBANK",
  "JAMUNA BANK": "JAMUNABANK",
  "ASIATIC LABORATORIES": "ASIATICLAB",
  "BSCCL": "BSCPLC",
};

async function main() {
  console.log(`Reading ${xlsxPath} → "${SHEET}"`);
  console.log(`Range: ${fromDate.toISOString().slice(0, 10)} → ${toDate.toISOString().slice(0, 10)}`);
  console.log(`Dry-run: ${dryRun}`);
  console.log("");

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.resolve(xlsxPath));
  const ws = wb.getWorksheet(SHEET);
  if (!ws) {
    console.error(`Sheet "${SHEET}" not found`);
    process.exit(1);
  }

  // Parse rows. Headers at row 3. Data from row 4.
  type WbRow = {
    rowNum: number;
    tradeDate: Date;
    serial: number;
    rawTicker: string;
    side: "BUY" | "SELL";
    quantity: number;
    rate: number;
    grossAmount: number;
  };
  const rows: WbRow[] = [];
  ws.eachRow((row, rowNum) => {
    if (rowNum < 4) return;
    const dval = row.getCell(5).value as unknown; // col E = Date Value (serial)
    const stock = row.getCell(7).value as unknown; // col G = Stock
    const bs = row.getCell(8).value as unknown;    // col H = B/S
    const qty = row.getCell(9).value as unknown;   // col I = Quantity
    const rate = row.getCell(10).value as unknown; // col J = Rate
    const amt = row.getCell(11).value as unknown;  // col K = Amount

    if (typeof dval !== "number" || !stock || (bs !== "B" && bs !== "S")) return;

    const tradeDate = excelSerialToDate(dval);
    if (tradeDate < fromDate || tradeDate > toDate) return;
    const cleanTicker = String(stock).trim().toUpperCase();
    const remappedTicker = TICKER_REMAP[cleanTicker] ?? cleanTicker;

    rows.push({
      rowNum,
      tradeDate,
      serial: dval,
      rawTicker: remappedTicker,
      side: bs === "B" ? "BUY" : "SELL",
      quantity: numLike(qty),
      rate: numLike(rate),
      grossAmount: numLike(amt),
    });
  });

  console.log(`Parsed ${rows.length} candidate rows from workbook.`);

  // Validate instruments + bank routing.
  const instruments = await prisma.instrument.findMany();
  const instMap = new Map(instruments.map((i) => [i.code, i]));
  const missing = [...new Set(rows.map((r) => r.rawTicker))].filter((c) => !instMap.has(c));
  if (missing.length > 0) {
    console.error("ERROR: tickers in workbook with no matching Instrument row:");
    for (const m of missing) console.error(`  ${m}`);
    console.error("Add them to prisma/seed/instruments.ts (with TICKER_REMAP if needed) and re-seed.");
    process.exit(1);
  }

  // Pick the FY for each row.
  const fyRows = await prisma.fiscalYear.findMany();
  const pickFy = (d: Date) => fyRows.find((f) => d >= f.startsOn && d <= f.endsOn);
  for (const r of rows) {
    if (!pickFy(r.tradeDate)) {
      console.error(`ERROR: row ${r.rowNum} date ${r.tradeDate.toISOString().slice(0, 10)} has no matching fiscal year`);
      process.exit(1);
    }
  }

  // Default bank A/C for the backfill — workbook doesn't carry this per row.
  // Pinki can rename later via /journals/voucher/<batch>/edit.
  const defaultBank = "Brac Bank (A/C No. 1513204232046002)";
  const bankExists = await prisma.chartOfAccount.findUnique({ where: { name: defaultBank } });
  if (!bankExists) {
    console.error(`ERROR: default bank "${defaultBank}" not in chart_of_accounts`);
    process.exit(1);
  }

  // Sort by (tradeDate, rowNum) — workbook row order breaks ties.
  rows.sort((a, b) => (a.tradeDate < b.tradeDate ? -1 : a.tradeDate > b.tradeDate ? 1 : a.rowNum - b.rowNum));

  // Idempotency: skip rows that already exist for the same (date, ticker,
  // side, quantity, rate).
  const existing = await prisma.trade.findMany({
    where: {
      tradeDate: { gte: fromDate, lte: toDate },
    },
  });
  const dedupKey = (
    d: Date,
    code: string,
    side: string,
    qty: number,
    rate: number,
  ) => `${d.toISOString().slice(0, 10)}|${code}|${side}|${qty.toFixed(4)}|${rate.toFixed(6)}`;
  const seen = new Set(existing.map((e) => dedupKey(e.tradeDate, e.instrumentCode, e.side, Number(e.quantity), Number(e.rate))));

  console.log(`Existing trades in DB for window: ${existing.length}`);
  console.log("");

  let inserted = 0;
  let skipped = 0;
  for (const r of rows) {
    const key = dedupKey(r.tradeDate, r.rawTicker, r.side, r.quantity, r.rate);
    if (seen.has(key)) {
      skipped++;
      continue;
    }
    const fy = pickFy(r.tradeDate)!;
    const inst = instMap.get(r.rawTicker)!;

    // Compute cost basis for SELL by replaying prior DB trades for this
    // instrument up to (and including) this trade's date.
    let costBasis: number | null = null;
    let realisedPnl: number | null = null;
    if (r.side === "SELL") {
      const prior = await prisma.trade.findMany({
        where: { instrumentCode: inst.code, tradeDate: { lte: r.tradeDate } },
        orderBy: [{ tradeDate: "asc" }, { createdAt: "asc" }],
      });
      const snap = costBasisOnSell(fromPrismaTrades(prior), {
        instrumentCode: inst.code,
        quantity: r.quantity,
        grossAmount: r.grossAmount,
      });
      if (snap.quantityAfter < -0.0001) {
        console.warn(
          `WARN row ${r.rowNum} (${r.rawTicker} SELL ${r.quantity}): would drive holdings negative. Inserting anyway — fix manually after backfill.`,
        );
      }
      costBasis = round2(snap.costBasis);
      realisedPnl = round2(snap.realisedPnl);
    }

    if (dryRun) {
      console.log(
        `  + ${r.tradeDate.toISOString().slice(0, 10)}  ${r.side}  ${r.rawTicker.padEnd(12)}  qty=${r.quantity.toString().padStart(8)}  rate=${r.rate.toFixed(4).padStart(10)}  gross=${r.grossAmount.toFixed(2).padStart(14)}${costBasis !== null ? `  cost=${costBasis.toFixed(2)}  pnl=${realisedPnl?.toFixed(2)}` : ""}`,
      );
      inserted++;
      continue;
    }

    // Insert trade + post journal in one tx.
    const batchId = randomUUID();
    const tradeId = randomUUID();
    await prisma.$transaction(async (tx) => {
      const voucherNo = await allocateVoucherNo(tx, fy.id, fy.label, r.side === "BUY" ? "BV" : "SV");
      await tx.trade.create({
        data: {
          id: tradeId,
          tradeDate: r.tradeDate,
          fiscalYearId: fy.id,
          instrumentCode: inst.code,
          side: r.side,
          quantity: r.quantity,
          rate: r.rate,
          grossAmount: round2(r.grossAmount),
          bankAccount: defaultBank,
          costBasis,
          realisedPnl,
          journalBatchId: batchId,
          remarks: "backfilled from workbook",
        },
      });

      const lines = buildJournalLines({
        side: r.side,
        entryDate: r.tradeDate,
        fiscalYearId: fy.id,
        instrumentCode: inst.code,
        investmentAccount: inst.investmentAccount,
        bankAccount: defaultBank,
        grossAmount: round2(r.grossAmount),
        costBasis,
        realisedPnl,
        voucherNo,
        batchId,
        description: `BACKFILL ${r.side} ${r.quantity} ${inst.code} @ ${r.rate}`,
      });
      await tx.journal.createMany({ data: lines });
    });
    inserted++;
  }

  console.log("");
  console.log(`Done. ${dryRun ? "[DRY] would insert" : "inserted"} ${inserted} trade row(s); skipped ${skipped} duplicate(s).`);
}

function buildJournalLines(args: {
  side: "BUY" | "SELL";
  entryDate: Date;
  fiscalYearId: string;
  instrumentCode: string;
  investmentAccount: string;
  bankAccount: string;
  grossAmount: number;
  costBasis: number | null;
  realisedPnl: number | null;
  voucherNo: string;
  batchId: string;
  description: string;
}) {
  const REALISED = "Realised Gain/(Loss) on Investments";
  const base = {
    entryDate: args.entryDate,
    description: args.description,
    voucherNo: args.voucherNo,
    fiscalYearId: args.fiscalYearId,
    batchId: args.batchId,
    instrumentCode: args.instrumentCode,
  };
  if (args.side === "BUY") {
    return [
      { ...base, txnType: "BV", accountName: args.investmentAccount, debit: args.grossAmount, credit: 0 },
      { ...base, txnType: "BV", accountName: args.bankAccount, debit: 0, credit: args.grossAmount },
    ];
  }
  const cost = args.costBasis ?? 0;
  const pnl = args.realisedPnl ?? 0;
  const lines = [
    { ...base, txnType: "SV", accountName: args.bankAccount, debit: args.grossAmount, credit: 0 },
    { ...base, txnType: "SV", accountName: args.investmentAccount, debit: 0, credit: cost },
  ];
  if (Math.abs(pnl) >= 0.005) {
    if (pnl > 0) lines.push({ ...base, txnType: "SV", accountName: REALISED, debit: 0, credit: Math.abs(pnl) });
    else lines.push({ ...base, txnType: "SV", accountName: REALISED, debit: Math.abs(pnl), credit: 0 });
  }
  return lines;
}

function excelSerialToDate(serial: number): Date {
  // Excel epoch is 1899-12-30 (accounting for 1900-leap-year bug).
  const ms = (serial - 25569) * 86400 * 1000;
  return new Date(ms);
}

function numLike(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") return Number(v);
  if (v && typeof v === "object" && "result" in v) return Number((v as { result: unknown }).result ?? 0);
  return 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const a of argv) {
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      out[k] = v ?? true;
    }
  }
  return out;
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
