// POST /api/exports/reconcile/xlsx — build the reconciliation report
// workbook from the findings the client already computed (posted as JSON),
// so no re-parse / re-fetch is needed. One sheet per category + a summary.

import { NextResponse, type NextRequest } from "next/server";
import ExcelJS from "exceljs";
import { requireRole } from "@/lib/auth";
import type { Finding, FindingCategory, ReconcileResult } from "@/lib/reconcile-ledger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CAT_LABEL: Record<FindingCategory, string> = {
  missing: "Missing (not entered)",
  mismatch: "Wrongly entered",
  date_shift: "Mis-dated",
  desync: "Trade-journal desync",
  extra: "Extra (not on statement)",
  holding: "Holdings / OB",
};
const CAT_ORDER: FindingCategory[] = ["missing", "mismatch", "date_shift", "desync", "extra", "holding"];

export async function POST(req: NextRequest) {
  await requireRole(["admin", "checker", "accountant"]);
  const form = await req.formData();
  let payload: { fyLabel: string; summary: ReconcileResult["summary"]; findings: Finding[] };
  try {
    payload = JSON.parse(String(form.get("payload") ?? "{}"));
  } catch {
    return NextResponse.json({ error: "bad payload" }, { status: 400 });
  }
  const findings = payload.findings ?? [];

  const wb = new ExcelJS.Workbook();
  wb.creator = "ekush-erp";

  const summary = wb.addWorksheet("Summary");
  summary.addRow(["Ledger reconciliation", payload.fyLabel ?? ""]);
  summary.addRow([]);
  summary.addRow(["Category", "Count"]);
  for (const c of CAT_ORDER) summary.addRow([CAT_LABEL[c], payload.summary?.[c] ?? 0]);
  summary.addRow(["Matched", payload.summary?.matched ?? 0]);
  summary.getRow(1).font = { bold: true, size: 14 };
  summary.getRow(3).font = { bold: true };
  summary.columns = [{ width: 28 }, { width: 14 }];

  const cols = ["Date", "Instrument", "Side", "Ledger qty", "Ledger rate", "Ledger gross", "Ledger comm", "x-sys qty", "x-sys rate", "x-sys gross", "Detail", "Source", "Fix link"];
  for (const c of CAT_ORDER) {
    const rows = findings.filter((f) => f.category === c);
    if (rows.length === 0) continue;
    const ws = wb.addWorksheet(CAT_LABEL[c].slice(0, 31));
    ws.addRow(cols);
    ws.getRow(1).font = { bold: true };
    for (const f of rows) {
      ws.addRow([
        f.date ?? "",
        f.instrumentCode ?? "",
        f.side ?? "",
        f.ledger?.quantity ?? "",
        f.ledger?.rate ?? "",
        f.ledger?.grossAmount ?? "",
        f.ledger?.commission ?? "",
        f.db?.quantity ?? "",
        f.db?.rate ?? "",
        f.db?.grossAmount ?? "",
        f.detail,
        f.ledger?.source ?? "",
        f.fixHref ?? "",
      ]);
    }
    ws.columns = cols.map((_, i) => ({ width: i === 10 ? 50 : i === 12 ? 32 : 13 }));
  }

  const buf = await wb.xlsx.writeBuffer();
  return new NextResponse(buf, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="reconciliation-${(payload.fyLabel ?? "").replace(/\W+/g, "-")}.xlsx"`,
    },
  });
}
