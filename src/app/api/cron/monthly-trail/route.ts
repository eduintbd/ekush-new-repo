// GET / POST /api/cron/monthly-trail
// Computes a `trail` CommissionRun row for every (agent, agent_investor)
// whose term cadence is **monthly**, for the requested month. Terms set to
// quarterly are paid by /api/cron/quarterly-trail instead. Idempotent via the
// (agent_investor_id, type, period_start, period_end) unique constraint, so
// the monthly and quarterly runs never double-pay the same investor.
//
// Auth: `Authorization: Bearer $CRON_SECRET` (Vercel Cron) or
// `x-cron-secret: $CRON_SECRET` (manual / external scheduler).
//
// Month selection:
//   - GET with no params → just-completed calendar month (intended use when
//     Vercel Cron fires on the 1st of every month).
//   - POST `{ monthStart, monthEnd }` body or GET query params → explicit.
//
// Schedule: 03:00 UTC on the 1st of every month via vercel.json.

import { NextResponse, type NextRequest } from "next/server";
import { runTrail } from "@/lib/run-trail";
import { authoriseCron, lastCompletedMonth, todayUtc } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function resolveMonth(
  req: NextRequest,
): Promise<{ mStart: Date; mEnd: Date; monthStart: string; monthEnd: string }> {
  if (req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as {
      monthStart?: string;
      monthEnd?: string;
    };
    if (body.monthStart && body.monthEnd) {
      return {
        mStart: new Date(`${body.monthStart}T00:00:00Z`),
        mEnd: new Date(`${body.monthEnd}T00:00:00Z`),
        monthStart: body.monthStart,
        monthEnd: body.monthEnd,
      };
    }
  }
  const url = new URL(req.url);
  const ms = url.searchParams.get("monthStart");
  const me = url.searchParams.get("monthEnd");
  if (ms && me) {
    return {
      mStart: new Date(`${ms}T00:00:00Z`),
      mEnd: new Date(`${me}T00:00:00Z`),
      monthStart: ms,
      monthEnd: me,
    };
  }
  const m = lastCompletedMonth(todayUtc());
  return {
    mStart: m.start,
    mEnd: m.endInclusive,
    monthStart: m.start.toISOString().slice(0, 10),
    monthEnd: m.endInclusive.toISOString().slice(0, 10),
  };
}

async function handle(req: NextRequest) {
  if (!authoriseCron(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { mStart, mEnd, monthStart, monthEnd } = await resolveMonth(req);

  const result = await runTrail(mStart, mEnd, "monthly");

  console.log(
    JSON.stringify({
      event: "commission.run",
      type: "monthly-trail",
      monthStart,
      monthEnd,
      ...result,
      at: new Date().toISOString(),
    }),
  );

  return NextResponse.json({
    created: result.created,
    skipped: result.skipped,
    month: { monthStart, monthEnd },
  });
}

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}
