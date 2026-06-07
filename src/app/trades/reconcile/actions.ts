"use server";

// Two-phase reconciliation flow, driven by useActionState:
//   phase "parse"     — extract trades from the uploaded broker/fund
//                       statements (PDF via unpdf, CSV via text) → review.
//   phase "reconcile" — diff the confirmed ledger rows against x-system's
//                       Trade table + journals for the FY → report.
// Pure classification lives in src/lib/reconcile-ledger.ts; this file only
// does the I/O (file reads, PDF text extraction, DB fetch, shaping).

import { extractText, getDocumentProxy } from "unpdf";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { detectAndParse, type LedgerRow, type LedgerHolding } from "@/lib/ledger-parsers";
import { replayTrades, fromPrismaTrades } from "@/lib/portfolio";
import {
  reconcileLedger,
  type DbTrade,
  type JournalSummary,
  type ReconcileResult,
} from "@/lib/reconcile-ledger";

export type ReconcileState =
  | { phase: "idle" }
  | { phase: "error"; message: string }
  | {
      phase: "review";
      rows: LedgerRow[];
      holdings: LedgerHolding[];
      warnings: string[];
      files: { name: string; profile: string; source: string; rows: number; holdings: number }[];
    }
  | { phase: "report"; result: ReconcileResult; rows: LedgerRow[]; holdings: LedgerHolding[]; fyLabel: string };

async function fileToText(file: File): Promise<string> {
  if (file.name.toLowerCase().endsWith(".csv")) return file.text();
  const buf = new Uint8Array(await file.arrayBuffer());
  const pdf = await getDocumentProxy(buf);
  const r = await extractText(pdf, { mergePages: true });
  return Array.isArray(r.text) ? r.text.join("\n") : r.text;
}

export async function reconcileFlow(_prev: ReconcileState, formData: FormData): Promise<ReconcileState> {
  await requireRole(["admin", "checker", "accountant"]);
  const phase = String(formData.get("phase") ?? "");

  try {
    if (phase === "parse") {
      const files = formData.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
      if (files.length === 0) return { phase: "error", message: "Pick at least one statement file." };

      const instruments = await prisma.instrument.findMany({ select: { code: true } });
      const knownCodes = new Set(instruments.map((i) => i.code));

      const rows: LedgerRow[] = [];
      const holdings: LedgerHolding[] = [];
      const warnings: string[] = [];
      const fileMeta: { name: string; profile: string; source: string; rows: number; holdings: number }[] = [];
      for (const f of files) {
        const text = await fileToText(f);
        const parsed = detectAndParse(text, f.name, knownCodes);
        rows.push(...parsed.rows);
        holdings.push(...parsed.holdings);
        warnings.push(...parsed.warnings);
        fileMeta.push({ name: f.name, profile: parsed.profile, source: parsed.source, rows: parsed.rows.length, holdings: parsed.holdings.length });
      }
      rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.instrumentCode! < b.instrumentCode! ? -1 : 1));
      return { phase: "review", rows, holdings, warnings, files: fileMeta };
    }

    if (phase === "reconcile") {
      const rows = JSON.parse(String(formData.get("rowsJson") ?? "[]")) as LedgerRow[];
      const holdings = JSON.parse(String(formData.get("holdingsJson") ?? "[]")) as LedgerHolding[];
      const fyId = String(formData.get("fiscalYearId") ?? "");
      const fy = await prisma.fiscalYear.findUnique({ where: { id: fyId } });
      if (!fy) return { phase: "error", message: "Pick a fiscal year." };
      const fyStart = fy.startsOn.toISOString().slice(0, 10);
      const fyEnd = fy.endsOn.toISOString().slice(0, 10);

      const allTrades = await prisma.trade.findMany({ orderBy: [{ tradeDate: "asc" }, { createdAt: "asc" }] });
      const dbTrades: DbTrade[] = allTrades.map((t) => ({
        id: t.id,
        date: t.tradeDate.toISOString().slice(0, 10),
        instrumentCode: t.instrumentCode,
        side: t.side as "BUY" | "SELL",
        quantity: Number(t.quantity),
        rate: Number(t.rate),
        grossAmount: Number(t.grossAmount),
        commission: Number(t.commission ?? 0),
        journalBatchId: t.journalBatchId,
        isOpening: /opening position seeded/i.test(t.remarks ?? ""),
      }));

      // Per-voucher summary for the desync check.
      const batchIds = dbTrades.map((t) => t.journalBatchId).filter((b): b is string => Boolean(b));
      const journals = batchIds.length
        ? await prisma.journal.findMany({ where: { batchId: { in: batchIds } }, select: { batchId: true, accountName: true, debit: true, credit: true, entryDate: true } })
        : [];
      const linesByBatch = new Map<string, typeof journals>();
      for (const j of journals) {
        if (!j.batchId) continue;
        (linesByBatch.get(j.batchId) ?? linesByBatch.set(j.batchId, []).get(j.batchId)!).push(j);
      }
      const journalByBatch: Record<string, JournalSummary> = {};
      for (const t of dbTrades) {
        if (!t.journalBatchId) continue;
        const lines = linesByBatch.get(t.journalBatchId) ?? [];
        if (lines.length === 0) continue;
        const sumDr = lines.reduce((s, l) => s + Number(l.debit), 0);
        const sumCr = lines.reduce((s, l) => s + Number(l.credit), 0);
        const investmentLeg = lines
          .filter((l) => l.accountName.includes("Investment"))
          .reduce((s, l) => s + Number(t.side === "BUY" ? l.debit : l.credit), 0);
        journalByBatch[t.journalBatchId] = {
          investmentLeg,
          entryDate: lines[0].entryDate.toISOString().slice(0, 10),
          balanced: Math.abs(sumDr - sumCr) < 0.01,
        };
      }

      // Current x-system holdings per instrument (full replay).
      const { byInstrument } = replayTrades(fromPrismaTrades(allTrades));
      const dbHoldings: Record<string, { quantity: number; totalCost: number }> = {};
      for (const [code, st] of byInstrument) dbHoldings[code] = { quantity: st.quantity, totalCost: st.totalCost };

      const result = reconcileLedger({ ledgerRows: rows, ledgerHoldings: holdings, dbTrades, journalByBatch, dbHoldings, fyStart, fyEnd });
      return { phase: "report", result, rows, holdings, fyLabel: fy.label };
    }

    return { phase: "error", message: "Unknown action." };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[reconcileFlow] failed:", err);
    return { phase: "error", message: msg.slice(0, 300) };
  }
}
