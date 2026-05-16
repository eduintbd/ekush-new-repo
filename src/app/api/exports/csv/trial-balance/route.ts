// CSV export of the trial balance for a given fiscal year. Mirrors what
// /trial-balance renders on screen.

import { type NextRequest } from "next/server";
import { requireStaff } from "@/lib/auth";
import { getTrialBalance } from "@/lib/trial-balance";
import { csvResponse, toCsv } from "@/lib/csv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  await requireStaff();
  const fyId = req.nextUrl.searchParams.get("fy");
  if (!fyId) return new Response("fy required", { status: 400 });

  const report = await getTrialBalance(fyId);
  const rows: Array<Record<string, unknown>> = report.rows.map((r) => ({
    Sl: r.sl,
    Account: r.accountName,
    "Normal balance": r.normalBalance as string,
    "Period debit": r.grossDebit,
    "Period credit": r.grossCredit,
    "Net debit (K)": r.netDebit,
    "Net credit (L)": r.netCredit,
  }));
  rows.push({
    Sl: 0,
    Account: "TOTALS",
    "Normal balance": "",
    "Period debit": report.totals.grossDebit,
    "Period credit": report.totals.grossCredit,
    "Net debit (K)": report.totals.netDebit,
    "Net credit (L)": report.totals.netCredit,
  });

  const filename = `trial-balance-${report.fiscalYearLabel}.csv`;
  return csvResponse(toCsv(rows), filename);
}
