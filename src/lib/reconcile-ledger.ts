// Pure reconciliation engine: confirmed ledger rows (union of all uploaded
// broker/fund statements) vs x-system's Trade rows + journals for the FY.
// No DB / I/O here — the server action fetches and shapes the inputs, this
// classifies every difference. Mirrors the ad-hoc Python diff that found
// the BANKASIA rate, the combined EFUF sell, the PRIMEBANK date-shift, and
// the trade↔journal desyncs.

import type { LedgerRow, LedgerHolding } from "./ledger-parsers/types";

export type FindingCategory = "missing" | "extra" | "mismatch" | "date_shift" | "desync" | "holding";

export type DbTrade = {
  id: string;
  date: string; // YYYY-MM-DD
  instrumentCode: string;
  side: "BUY" | "SELL";
  quantity: number;
  rate: number;
  grossAmount: number;
  commission: number;
  journalBatchId: string | null;
  /** Synthetic opening-balance seed (2025-07-01) — not a real FY trade, so
   *  excluded from matching (it would otherwise show as a false "extra"). */
  isOpening?: boolean;
};

/** Per-voucher facts the desync check needs (built from the journal lines). */
export type JournalSummary = { investmentLeg: number; entryDate: string; balanced: boolean };

export type Finding = {
  category: FindingCategory;
  instrumentCode: string | null;
  side?: "BUY" | "SELL";
  date?: string;
  ledger?: { quantity: number; rate: number; grossAmount: number; commission: number; source: string };
  db?: { id: string; date: string; quantity: number; rate: number; grossAmount: number; commission: number };
  detail: string;
  fixHref?: string;
};

export type ReconcileInput = {
  ledgerRows: LedgerRow[];
  ledgerHoldings: LedgerHolding[];
  dbTrades: DbTrade[];
  journalByBatch?: Record<string, JournalSummary>;
  dbHoldings?: Record<string, { quantity: number; totalCost: number }>;
  fyStart: string; // YYYY-MM-DD inclusive
  fyEnd: string; // YYYY-MM-DD inclusive
};

export type ReconcileResult = {
  findings: Finding[];
  summary: Record<FindingCategory, number> & { matched: number; ledgerRows: number; dbTrades: number };
  warnings: string[];
};

const QTOL = 0.5;
const RTOL = 0.0005;
const ATOL = 1.0;

const inRange = (d: string, a: string, b: string) => d >= a && d <= b;
const exactKey = (d: string, c: string, s: string, q: number, r: number) =>
  `${d}|${c}|${s}|${q.toFixed(2)}|${r.toFixed(4)}`;
const looseKey = (d: string, c: string, s: string) => `${d}|${c}|${s}`;
const datelessKey = (c: string, s: string, q: number, r: number) => `${c}|${s}|${q.toFixed(2)}|${r.toFixed(4)}`;
const prefill = (l: { date: string; instrumentCode: string | null; side: string; quantity: number; rate: number; commission: number }) =>
  `/trades/new?tradeDate=${l.date}&instrumentCode=${l.instrumentCode ?? ""}&side=${l.side}&quantity=${l.quantity}&rate=${l.rate}&commission=${l.commission}`;

export function reconcileLedger(input: ReconcileInput): ReconcileResult {
  const warnings: string[] = [];
  const findings: Finding[] = [];

  // Scope to FY + resolved instruments. Unresolved ledger rows → warning.
  const L = input.ledgerRows
    .filter((r) => {
      if (!r.instrumentCode) {
        warnings.push(`Skipped unresolved ledger row: ${r.rawInstrument} ${r.side} ${r.quantity} on ${r.date}`);
        return false;
      }
      return inRange(r.date, input.fyStart, input.fyEnd);
    })
    .map((r) => ({ ...r, _used: false }));
  const D = input.dbTrades.filter((t) => !t.isOpening && inRange(t.date, input.fyStart, input.fyEnd)).map((t) => ({ ...t, _used: false }));

  let matched = 0;

  // Pass A — exact match (date|code|side|qty|rate).
  for (const l of L) {
    const d = D.find(
      (t) => !t._used && exactKey(t.date, t.instrumentCode, t.side, t.quantity, t.rate) === exactKey(l.date, l.instrumentCode!, l.side, l.quantity, l.rate),
    );
    if (d) {
      l._used = true;
      d._used = true;
      matched++;
    }
  }

  // Pass B — same date+code+side but qty/rate/amount differ → wrongly entered.
  for (const l of L) {
    if (l._used) continue;
    const d = D.find((t) => !t._used && looseKey(t.date, t.instrumentCode, t.side) === looseKey(l.date, l.instrumentCode!, l.side));
    if (!d) continue;
    l._used = true;
    d._used = true;
    const diffs: string[] = [];
    if (Math.abs(d.quantity - l.quantity) > QTOL) diffs.push(`qty ${d.quantity}→${l.quantity}`);
    if (Math.abs(d.rate - l.rate) > RTOL) diffs.push(`rate ${d.rate}→${l.rate}`);
    if (Math.abs(d.grossAmount - l.grossAmount) > ATOL) diffs.push(`gross ${d.grossAmount.toFixed(2)}→${l.grossAmount.toFixed(2)}`);
    if (Math.abs(d.commission - l.commission) > ATOL) diffs.push(`comm ${d.commission.toFixed(2)}→${l.commission.toFixed(2)}`);
    findings.push({
      category: "mismatch",
      instrumentCode: l.instrumentCode,
      side: l.side,
      date: l.date,
      ledger: { quantity: l.quantity, rate: l.rate, grossAmount: l.grossAmount, commission: l.commission, source: l.source },
      db: { id: d.id, date: d.date, quantity: d.quantity, rate: d.rate, grossAmount: d.grossAmount, commission: d.commission },
      detail: diffs.length ? `x-system vs ledger: ${diffs.join(", ")}` : "matched on date/side; values differ",
      fixHref: `/trades/${d.id}/edit`,
    });
  }

  // Pass C — same code+side+qty+rate, different date → mis-dated trade.
  for (const l of L) {
    if (l._used) continue;
    const d = D.find(
      (t) => !t._used && datelessKey(t.instrumentCode, t.side, t.quantity, t.rate) === datelessKey(l.instrumentCode!, l.side, l.quantity, l.rate),
    );
    if (!d) continue;
    l._used = true;
    d._used = true;
    findings.push({
      category: "date_shift",
      instrumentCode: l.instrumentCode,
      side: l.side,
      date: l.date,
      ledger: { quantity: l.quantity, rate: l.rate, grossAmount: l.grossAmount, commission: l.commission, source: l.source },
      db: { id: d.id, date: d.date, quantity: d.quantity, rate: d.rate, grossAmount: d.grossAmount, commission: d.commission },
      detail: `x-system dated ${d.date}, ledger dated ${l.date}`,
      fixHref: `/trades/${d.id}/edit`,
    });
  }

  // Remaining ledger rows → missing (journal never entered).
  for (const l of L) {
    if (l._used) continue;
    findings.push({
      category: "missing",
      instrumentCode: l.instrumentCode,
      side: l.side,
      date: l.date,
      ledger: { quantity: l.quantity, rate: l.rate, grossAmount: l.grossAmount, commission: l.commission, source: l.source },
      detail: `On ${l.source} but not in x-system — journal not entered`,
      fixHref: prefill(l),
    });
  }

  // Remaining DB trades → extra (in x-system, not on any statement).
  for (const d of D) {
    if (d._used) continue;
    findings.push({
      category: "extra",
      instrumentCode: d.instrumentCode,
      side: d.side,
      date: d.date,
      db: { id: d.id, date: d.date, quantity: d.quantity, rate: d.rate, grossAmount: d.grossAmount, commission: d.commission },
      detail: "In x-system but not found on any uploaded statement — verify it's correct",
      fixHref: `/trades/${d.id}/edit`,
    });
  }

  // Trade↔journal desync (voucher no longer matches the trade row).
  if (input.journalByBatch) {
    for (const t of input.dbTrades) {
      if (!t.journalBatchId) continue;
      const j = input.journalByBatch[t.journalBatchId];
      if (!j) {
        findings.push({ category: "desync", instrumentCode: t.instrumentCode, side: t.side, date: t.date, db: { id: t.id, date: t.date, quantity: t.quantity, rate: t.rate, grossAmount: t.grossAmount, commission: t.commission }, detail: "Trade has a voucher reference but no journal lines", fixHref: `/trades/${t.id}/edit` });
        continue;
      }
      const expected = t.side === "BUY" ? t.grossAmount + t.commission : null; // SELL invest-leg = costBasis (not derivable here)
      const issues: string[] = [];
      if (!j.balanced) issues.push("voucher unbalanced");
      if (j.entryDate !== t.date) issues.push(`voucher date ${j.entryDate} ≠ trade ${t.date}`);
      if (expected !== null && Math.abs(j.investmentLeg - expected) > ATOL) issues.push(`voucher amount ${j.investmentLeg.toFixed(2)} ≠ trade-implied ${expected.toFixed(2)}`);
      if (issues.length) {
        findings.push({
          category: "desync",
          instrumentCode: t.instrumentCode,
          side: t.side,
          date: t.date,
          db: { id: t.id, date: t.date, quantity: t.quantity, rate: t.rate, grossAmount: t.grossAmount, commission: t.commission },
          detail: issues.join("; "),
          fixHref: `/trades/${t.id}/edit`,
        });
      }
    }
  }

  // Holdings / opening-balance cross-check vs uploaded portfolio snapshots.
  if (input.dbHoldings) {
    for (const h of input.ledgerHoldings) {
      if (!h.instrumentCode) continue;
      const db = input.dbHoldings[h.instrumentCode];
      const dbQty = db?.quantity ?? 0;
      const dbCost = db?.totalCost ?? 0;
      const qtyDiff = Math.abs(dbQty - h.quantity) > QTOL;
      const costDiff = Math.abs(dbCost - h.totalCost) > 5;
      if (qtyDiff || costDiff) {
        findings.push({
          category: "holding",
          instrumentCode: h.instrumentCode,
          detail: `Holdings differ vs ${h.source}: qty x-sys ${dbQty} / ledger ${h.quantity}; cost x-sys ${dbCost.toFixed(2)} / ledger ${h.totalCost.toFixed(2)}${qtyDiff ? "" : " (qty matches — likely opening-balance cost)"}`,
        });
      }
    }
  }

  const summary = {
    missing: findings.filter((f) => f.category === "missing").length,
    extra: findings.filter((f) => f.category === "extra").length,
    mismatch: findings.filter((f) => f.category === "mismatch").length,
    date_shift: findings.filter((f) => f.category === "date_shift").length,
    desync: findings.filter((f) => f.category === "desync").length,
    holding: findings.filter((f) => f.category === "holding").length,
    matched,
    ledgerRows: L.length,
    dbTrades: D.length,
  };
  return { findings, summary, warnings };
}
