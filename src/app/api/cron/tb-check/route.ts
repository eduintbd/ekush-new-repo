// POST /api/cron/tb-check
// Iterates open fiscal years and verifies that each one's trial balance
// balances (Σ net debit ≈ Σ net credit). Logs an alertable error on any
// imbalance so the log drain / Datadog can page on-call. Returns a JSON
// summary suitable for cron-monitor scraping.
//
// Auth: shared-secret header X-Cron-Secret matching CRON_SECRET env var.
// Schedule: hourly is reasonable. The check is cheap on small datasets;
// for >100k journals the groupBy may want a SQL view.

import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getTrialBalance } from "@/lib/trial-balance";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type FyResult = {
  id: string;
  label: string;
  netDebit: number;
  netCredit: number;
  delta: number;
  balanced: boolean;
};

export async function POST(req: NextRequest) {
  if (req.headers.get("x-cron-secret") !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const fiscalYears = await prisma.fiscalYear.findMany({
    where: { isClosed: false },
    orderBy: { startsOn: "desc" },
    select: { id: true, label: true },
  });

  const results: FyResult[] = [];
  for (const fy of fiscalYears) {
    try {
      const tb = await getTrialBalance(fy.id);
      const delta = Math.abs(tb.totals.netDebit - tb.totals.netCredit);
      const result: FyResult = {
        id: fy.id,
        label: fy.label,
        netDebit: tb.totals.netDebit,
        netCredit: tb.totals.netCredit,
        delta,
        balanced: tb.isBalanced,
      };
      results.push(result);

      if (!tb.isBalanced) {
        // Loud log line so the drain / Datadog rule can match on `event`.
        console.error(
          JSON.stringify({
            event: "tb.out_of_balance",
            fiscalYearId: fy.id,
            fiscalYearLabel: fy.label,
            netDebit: tb.totals.netDebit,
            netCredit: tb.totals.netCredit,
            delta,
            at: new Date().toISOString(),
          }),
        );
      }
    } catch (e) {
      console.error(
        JSON.stringify({
          event: "tb.check_failed",
          fiscalYearId: fy.id,
          fiscalYearLabel: fy.label,
          error: e instanceof Error ? e.message : String(e),
          at: new Date().toISOString(),
        }),
      );
    }
  }

  const outOfBalance = results.filter((r) => !r.balanced).length;
  return NextResponse.json({
    checkedAt: new Date().toISOString(),
    fiscalYearsChecked: results.length,
    outOfBalance,
    results,
  });
}
