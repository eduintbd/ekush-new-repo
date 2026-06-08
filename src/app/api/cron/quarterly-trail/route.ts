// GET / POST /api/cron/quarterly-trail
// Computes a `trail` CommissionRun row for every (agent, agent_investor)
// whose term cadence is **quarterly**, for the requested quarter. Terms set
// to monthly are paid by /api/cron/monthly-trail instead. Idempotent via the
// (agent_investor_id, type, period_start, period_end) unique constraint.
//
// Auth: `Authorization: Bearer $CRON_SECRET` (Vercel Cron) or
// `x-cron-secret: $CRON_SECRET` (manual / external scheduler).
//
// Quarter selection:
//   - GET with no params → just-completed calendar quarter (intended use
//     when Vercel Cron fires on the 1st of Apr/Jul/Oct/Jan).
//   - POST `{ quarterStart, quarterEnd }` body or GET query params → explicit.
//
// Schedule: 03:00 UTC on the 1st of each quarter via vercel.json.

import { NextResponse, type NextRequest } from "next/server";
import { runTrail } from "@/lib/run-trail";
import { authoriseCron, lastCompletedQuarter, todayUtc } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function resolveQuarter(
  req: NextRequest,
): Promise<{ qStart: Date; qEnd: Date; quarterStart: string; quarterEnd: string }> {
  if (req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as {
      quarterStart?: string;
      quarterEnd?: string;
    };
    if (body.quarterStart && body.quarterEnd) {
      return {
        qStart: new Date(`${body.quarterStart}T00:00:00Z`),
        qEnd: new Date(`${body.quarterEnd}T00:00:00Z`),
        quarterStart: body.quarterStart,
        quarterEnd: body.quarterEnd,
      };
    }
  }
  const url = new URL(req.url);
  const qs = url.searchParams.get("quarterStart");
  const qe = url.searchParams.get("quarterEnd");
  if (qs && qe) {
    return {
      qStart: new Date(`${qs}T00:00:00Z`),
      qEnd: new Date(`${qe}T00:00:00Z`),
      quarterStart: qs,
      quarterEnd: qe,
    };
  }
  const q = lastCompletedQuarter(todayUtc());
  return {
    qStart: q.start,
    qEnd: q.endInclusive,
    quarterStart: q.start.toISOString().slice(0, 10),
    quarterEnd: q.endInclusive.toISOString().slice(0, 10),
  };
}

async function handle(req: NextRequest) {
  if (!authoriseCron(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { qStart, qEnd, quarterStart, quarterEnd } = await resolveQuarter(req);

  const result = await runTrail(qStart, qEnd, "quarterly");

  console.log(
    JSON.stringify({
      event: "commission.run",
      type: "quarterly-trail",
      quarterStart,
      quarterEnd,
      ...result,
      at: new Date().toISOString(),
    }),
  );

  return NextResponse.json({
    created: result.created,
    skipped: result.skipped,
    quarter: { quarterStart, quarterEnd },
  });
}

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}
