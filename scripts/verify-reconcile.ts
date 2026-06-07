/* eslint-disable */
// Verification harness for the ledger-reconciliation pipeline: parse the
// real broker/fund statements in x-system_inputs/ledger/, then reconcile
// against the live FY2025-26 DB — mirroring src/app/trades/reconcile/actions.ts.
// Run: npx tsx scripts/verify-reconcile.ts

import { config } from "dotenv";
config({ path: ".env" });

import fs from "node:fs";
import path from "node:path";
import { extractText, getDocumentProxy } from "unpdf";
import { PrismaClient } from "@/generated/prisma";
import { detectAndParse, type LedgerRow, type LedgerHolding } from "@/lib/ledger-parsers";
import { replayTrades, fromPrismaTrades } from "@/lib/portfolio";
import { reconcileLedger, type DbTrade, type JournalSummary } from "@/lib/reconcile-ledger";

const prisma = new PrismaClient();
const LEDGER_DIR = "C:/Users/USER/OneDrive/Desktop/x-system_inputs/ledger";
const EXTRA = ["C:/Users/USER/OneDrive/Desktop/x-system_inputs/23936_Led_01-06-2026.pdf"];

async function fileToText(p: string): Promise<string> {
  if (p.toLowerCase().endsWith(".csv")) return fs.readFileSync(p, "utf8");
  const buf = new Uint8Array(fs.readFileSync(p));
  const pdf = await getDocumentProxy(buf);
  const r = await extractText(pdf, { mergePages: true });
  return Array.isArray(r.text) ? r.text.join("\n") : r.text;
}

async function main() {
  const insts = await prisma.instrument.findMany({ select: { code: true } });
  const knownCodes = new Set(insts.map((i) => i.code));

  const files = [
    ...fs.readdirSync(LEDGER_DIR).filter((f) => /\.(pdf|csv)$/i.test(f) && !/dividend/i.test(f)).map((f) => path.join(LEDGER_DIR, f)),
    ...EXTRA.filter((f) => fs.existsSync(f)),
  ];

  const rows: LedgerRow[] = [];
  const holdings: LedgerHolding[] = [];
  const warnings: string[] = [];
  console.log("=== PARSE ===");
  for (const f of files) {
    const text = await fileToText(f);
    const parsed = detectAndParse(text, path.basename(f), knownCodes);
    rows.push(...parsed.rows);
    holdings.push(...parsed.holdings);
    warnings.push(...parsed.warnings);
    const buys = parsed.rows.filter((r) => r.side === "BUY").length;
    const sells = parsed.rows.filter((r) => r.side === "SELL").length;
    console.log(`  ${path.basename(f).padEnd(42)} profile=${parsed.profile.padEnd(15)} rows=${parsed.rows.length} (B${buys}/S${sells}) holdings=${parsed.holdings.length}`);
  }
  if (warnings.length) {
    console.log("\n  warnings:");
    for (const w of warnings.slice(0, 20)) console.log("   - " + w);
  }

  // DB shaping (mirror actions.ts reconcile phase)
  const allTrades = await prisma.trade.findMany({ orderBy: [{ tradeDate: "asc" }, { createdAt: "asc" }] });
  const dbTrades: DbTrade[] = allTrades.map((t) => ({
    id: t.id, date: t.tradeDate.toISOString().slice(0, 10), instrumentCode: t.instrumentCode,
    side: t.side as "BUY" | "SELL", quantity: Number(t.quantity), rate: Number(t.rate),
    grossAmount: Number(t.grossAmount), commission: Number(t.commission ?? 0),
    journalBatchId: t.journalBatchId, isOpening: /opening position seeded/i.test(t.remarks ?? ""),
  }));
  const batchIds = dbTrades.map((t) => t.journalBatchId).filter((b): b is string => Boolean(b));
  const journals = batchIds.length
    ? await prisma.journal.findMany({ where: { batchId: { in: batchIds } }, select: { batchId: true, accountName: true, debit: true, credit: true, entryDate: true } })
    : [];
  const linesByBatch = new Map<string, typeof journals>();
  for (const j of journals) { if (!j.batchId) continue; const a = linesByBatch.get(j.batchId) ?? []; a.push(j); linesByBatch.set(j.batchId, a); }
  const journalByBatch: Record<string, JournalSummary> = {};
  for (const t of dbTrades) {
    if (!t.journalBatchId) continue;
    const lines = linesByBatch.get(t.journalBatchId) ?? [];
    if (!lines.length) continue;
    const sumDr = lines.reduce((s, l) => s + Number(l.debit), 0);
    const sumCr = lines.reduce((s, l) => s + Number(l.credit), 0);
    const investmentLeg = lines.filter((l) => l.accountName.includes("Investment")).reduce((s, l) => s + Number(t.side === "BUY" ? l.debit : l.credit), 0);
    journalByBatch[t.journalBatchId] = { investmentLeg, entryDate: lines[0].entryDate.toISOString().slice(0, 10), balanced: Math.abs(sumDr - sumCr) < 0.01 };
  }
  const { byInstrument } = replayTrades(fromPrismaTrades(allTrades));
  const dbHoldings: Record<string, { quantity: number; totalCost: number }> = {};
  for (const [code, st] of byInstrument) dbHoldings[code] = { quantity: st.quantity, totalCost: st.totalCost };

  const fy = await prisma.fiscalYear.findFirst({ where: { label: "FY2025-26" } });
  const fyStart = fy ? fy.startsOn.toISOString().slice(0, 10) : "2025-07-01";
  const fyEnd = fy ? fy.endsOn.toISOString().slice(0, 10) : "2026-06-30";

  const result = reconcileLedger({ ledgerRows: rows, ledgerHoldings: holdings, dbTrades, journalByBatch, dbHoldings, fyStart, fyEnd });

  console.log("\n=== RECONCILE (FY2025-26) ===");
  console.log("  summary:", JSON.stringify(result.summary));
  const byCat: Record<string, typeof result.findings> = {};
  for (const f of result.findings) (byCat[f.category] ??= []).push(f);
  for (const cat of ["missing", "mismatch", "date_shift", "extra", "desync", "holding"]) {
    const fs = byCat[cat] ?? [];
    if (!fs.length) continue;
    console.log(`\n  -- ${cat.toUpperCase()} (${fs.length}) --`);
    for (const f of fs.slice(0, 25)) console.log(`     ${f.instrumentCode ?? "?"} ${f.side ?? ""} ${f.date ?? ""}  ${f.detail}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
