/* eslint-disable */
// One-off backfill: read a pre-extracted JSON of workbook trades,
// create one Trade row per line, generate the matching journal voucher
// (BV/SV). Idempotent — re-running won't duplicate (we key dedup on
// `(tradeDate, instrumentCode, side, quantity, rate)`).
//
// Why JSON, not direct .xlsx? ExcelJS chokes on this workbook's
// auto-filter formatting and silently drops most rows. Pre-extract with
// the Python helper at scripts/dump-trades-json.py instead.
//
// Usage:
//   npx tsx scripts/import-workbook-trades.ts \
//     --json="C:/Users/USER/AppData/Local/Temp/trade_backfill.json" \
//     [--dry]

import { config } from "dotenv";
config({ path: ".env" });

import fs from "node:fs";
import { PrismaClient } from "@/generated/prisma";
import { costBasisOnSell, fromPrismaTrades } from "@/lib/portfolio";

const prisma = new PrismaClient();

const args = parseArgs(process.argv.slice(2));
const jsonArg = typeof args.json === "string" ? args.json : "";
const openingsArg = typeof args.openings === "string" ? args.openings : "";
const jsonPath = jsonArg || "C:/Users/USER/AppData/Local/Temp/trade_backfill.json";
const openingsPath = openingsArg || "C:/Users/USER/AppData/Local/Temp/opening_positions.json";
const dryRun = Boolean(args.dry);

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

type JsonRow = {
  serial: number;
  stock: string;
  side: "BUY" | "SELL";
  quantity: number;
  rate: number;
  grossAmount: number;
};

type OpeningRow = {
  instrumentCode: string;
  quantity: number;
  avgCost: number;
  totalCost: number;
};

async function main() {
  console.log(`Reading ${jsonPath}`);
  console.log(`Openings: ${openingsPath}`);
  console.log(`Dry-run: ${dryRun}`);
  console.log("");

  // Step 0: ingest opening positions (Jun 30, 2025) as synthetic Trade
  // rows. NO journal posted — those positions are already booked via OB
  // journal entries on the same date. The synthetic rows just give the
  // cost-basis engine a starting state to replay sells against.
  if (fs.existsSync(openingsPath)) {
    const openingRaw = fs.readFileSync(openingsPath, "utf8");
    const openings = (JSON.parse(openingRaw) as OpeningRow[]).filter(
      (o) => o.quantity > 0,
    );
    // Synthetic opening Trade rows are dated Jul 1, 2025 (first day of
    // FY2025-26) — NOT Jun 30, 2025. Reason: Jun 30 belongs to FY2024-25
    // which isn't in the DB. The semantic "opening" intent is preserved
    // by the remarks column and the fact that no journal is posted (OB
    // journals on the same instruments already exist on Jun 30).
    const obDate = new Date("2025-07-01T00:00:00Z");
    const fyRows = await prisma.fiscalYear.findMany();
    const fy = fyRows.find((f) => obDate >= f.startsOn && obDate <= f.endsOn);
    if (!fy) {
      console.error("ERROR: no fiscal year contains Jul 1, 2025 — cannot seed openings");
      process.exit(1);
    }
    const insts = await prisma.instrument.findMany();
    const instSet = new Set(insts.map((i) => i.code));

    let openingInserted = 0, openingSkipped = 0;
    for (const o of openings) {
      if (!instSet.has(o.instrumentCode)) {
        console.warn(`  skip opening ${o.instrumentCode}: not in Instrument master`);
        continue;
      }
      // Idempotent: skip if a synthetic opening already exists.
      const exists = await prisma.trade.findFirst({
        where: {
          tradeDate: obDate,
          instrumentCode: o.instrumentCode,
          remarks: "opening position seeded from workbook",
        },
      });
      if (exists) {
        openingSkipped++;
        continue;
      }
      if (dryRun) {
        console.log(`  [DRY] opening ${o.instrumentCode}: qty=${o.quantity} avgCost=${o.avgCost} cost=${o.totalCost}`);
        openingInserted++;
        continue;
      }
      await prisma.trade.create({
        data: {
          tradeDate: obDate,
          fiscalYearId: fy.id,
          instrumentCode: o.instrumentCode,
          side: "BUY",
          quantity: o.quantity,
          rate: o.avgCost,
          grossAmount: o.totalCost,
          bankAccount: "Opening Balance", // marker — no journal posted
          journalBatchId: null, // intentional: OB journals already exist
          remarks: "opening position seeded from workbook",
        },
      });
      openingInserted++;
    }
    console.log(`Openings: ${openingInserted} inserted, ${openingSkipped} already present.`);
    console.log("");
  } else {
    console.log("(no openings file — skipping opening-position seed)");
    console.log("");
  }

  const raw = fs.readFileSync(jsonPath, "utf8");
  const jsonRows = JSON.parse(raw) as JsonRow[];

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
  const rows: WbRow[] = jsonRows.map((r, i) => ({
    rowNum: i + 1,
    tradeDate: excelSerialToDate(r.serial),
    serial: r.serial,
    rawTicker: TICKER_REMAP[r.stock.trim().toUpperCase()] ?? r.stock.trim().toUpperCase(),
    side: r.side,
    quantity: r.quantity,
    rate: r.rate,
    grossAmount: r.grossAmount,
  }));

  console.log(`Parsed ${rows.length} rows from JSON.`);

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
  // side, quantity, rate). Scope the dedup query to the date range present
  // in the input JSON.
  const minDate = rows.reduce((m, r) => (r.tradeDate < m ? r.tradeDate : m), rows[0].tradeDate);
  const maxDate = rows.reduce((m, r) => (r.tradeDate > m ? r.tradeDate : m), rows[0].tradeDate);
  const existing = await prisma.trade.findMany({
    where: {
      tradeDate: { gte: minDate, lte: maxDate },
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

    // Insert trade row only — DO NOT post a journal. The historical
    // period is already booked via hand-entered legacy journals
    // (Investment in share + Capital Gain/Capital Loss). Posting
    // auto-journals here would double-count cash + realised P&L.
    // Trade rows still feed /trades + /portfolio for analytics.
    await prisma.trade.create({
      data: {
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
        journalBatchId: null,
        remarks: "backfilled from workbook (no auto-journal — legacy journals exist)",
      },
    });
    inserted++;
  }

  console.log("");
  console.log(`Done. ${dryRun ? "[DRY] would insert" : "inserted"} ${inserted} trade row(s); skipped ${skipped} duplicate(s).`);
}

function excelSerialToDate(serial: number): Date {
  // Excel epoch is 1899-12-30 (accounting for 1900-leap-year bug).
  const ms = (serial - 25569) * 86400 * 1000;
  return new Date(ms);
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
