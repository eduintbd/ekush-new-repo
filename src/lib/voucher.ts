// Shared voucher-number allocator. Lives outside any "use server" file so
// it can be imported by both src/app/journals/actions.ts (createJournal /
// updateJournalBatch) and src/lib/trades.ts (auto-journal-from-trade).
//
// Voucher number shape: '{PREFIX}/{FY_SHORT}/{####}' where:
//   PREFIX   — JV (manual journal), OB (opening balance), BV (buy trade),
//              SV (sell trade), FV (fair-value adjustment)
//   FY_SHORT — '25-26' (extracted from 'FY2025-26')
//   ####     — zero-padded 4-digit sequence, scoped per (fiscalYear, prefix)
//
// Allocation must run inside the same transaction as the createMany that
// inserts the journal lines — otherwise concurrent saves could collide.

import type { Prisma } from "@/generated/prisma";

export type VoucherPrefix = "JV" | "OB" | "BV" | "SV" | "FV" | "TX";

/** Derive the short fiscal-year suffix from a FiscalYear.label.
 *  'FY2025-26' → '25-26'; 'FY2026-27' → '26-27'; falls back to stripping 'FY'. */
export function shortFyLabel(label: string): string {
  const m = label.match(/(\d{2})(\d{2})-(\d{2})/);
  return m ? `${m[2]}-${m[3]}` : label.replace(/^FY/, "");
}

/**
 * Classify a voucher as *derived* (projected from an upstream
 * system-of-record) vs *manual*. Derived vouchers must NOT be edited
 * line-by-line — that only patches the GL and leaves the source (and the
 * views that read it) stale. They are edited at their source, which
 * re-posts the voucher:
 *   - 'trade' → BV/SV, backed by a Trade row      → /trades/<id>/edit
 *   - 'fva'   → FV, posted by /portfolio "Revalue" → /portfolio
 * Everything else (manual JV, opening-balance OB, tax) returns null and
 * stays directly editable.
 */
export function derivedVoucherKind(
  voucherNo: string | null | undefined,
  txnType: string | null | undefined,
): "trade" | "fva" | null {
  const prefix = (voucherNo?.split("/")[0] ?? "").toUpperCase();
  const tt = (txnType ?? "").toUpperCase();
  if (prefix === "BV" || prefix === "SV" || tt === "BV" || tt === "SV") return "trade";
  if (prefix === "FV" || tt === "FV") return "fva";
  return null;
}

/**
 * Allocate the next sequential voucher number for (fiscalYear, prefix).
 * Must be called inside an active transaction (`tx`) so the MAX read and
 * the subsequent INSERT happen under the same snapshot.
 *
 * The raw SQL avoids a race window: if we did
 *   const last = await tx.journal.findFirst({...}); const next = ...;
 * two concurrent calls could both see `last.seq=42` and both write `43`.
 * The MAX-in-SELECT approach is acceptable here because we always wrap
 * this call in a tx where the immediately-following createMany inserts
 * a row using the returned voucherNo, locking the sequence.
 */
export async function allocateVoucherNo(
  tx: Prisma.TransactionClient,
  fiscalYearId: string,
  fyLabel: string,
  prefix: VoucherPrefix,
): Promise<string> {
  const fyShort = shortFyLabel(fyLabel);
  const rows = await tx.$queryRawUnsafe<Array<{ max_seq: string | null }>>(
    `SELECT MAX(SUBSTRING(voucher_no FROM '${prefix}/${fyShort}/([0-9]+)$')) AS max_seq
     FROM xsystem.journals
     WHERE fiscal_year_id = $1::uuid AND voucher_no LIKE '${prefix}/${fyShort}/%'`,
    fiscalYearId,
  );
  const nextSeq = Number(rows[0]?.max_seq ?? 0) + 1;
  return `${prefix}/${fyShort}/${String(nextSeq).padStart(4, "0")}`;
}
