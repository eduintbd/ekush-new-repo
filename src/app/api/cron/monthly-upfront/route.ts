// GET / POST /api/cron/monthly-upfront
// Evaluates the per-(agent, INVESTOR) combined-fund upfront high-water-mark for
// the just-completed month and posts upfront CommissionRun rows on any new-
// money increment above each investor's watermark. Idempotent via the watermark
// itself (re-running a period yields increment 0) and now also via the
// (agent_investor_id, type, period_start, period_end) unique index.
//
// GATED: this cron will not post until UPFRONT_POSTING_ENABLED=true — see the
// safety gate in handle(). "Post upfront now" in the admin UI is not gated.
//
// Auth: `Authorization: Bearer $CRON_SECRET` (Vercel Cron) or
// `x-cron-secret: $CRON_SECRET` (manual / external scheduler).
//
// Month selection:
//   - GET with no params → just-completed calendar month (Vercel Cron, 1st).
//   - POST `{ monthStart, monthEnd }` body or GET query params → explicit.
//
// Schedule: 03:00 UTC on the 1st of every month via vercel.json.

import { NextResponse, type NextRequest } from "next/server";
import { runUpfront } from "@/lib/run-upfront";
import { authoriseCron, lastCompletedMonth, todayUtc } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function resolveMonth(
  req: NextRequest,
): Promise<{ mStart: Date; mEnd: Date; monthStart: string; monthEnd: string }> {
  if (req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { monthStart?: string; monthEnd?: string };
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

  // SAFETY GATE. No upfront has ever been posted (commission_runs is empty),
  // and the watermark model is mid-change from per-fund to per-investor. An
  // unattended 1st-of-month run would post the first-ever real upfront —
  // against the OLD model — with nobody having reviewed a screen.
  //
  // The gate is on the CRON only. "Post upfront now" in the admin UI stays
  // available, because that is a deliberate human action against a preview
  // they are looking at; this is about the 03:00 UTC job nobody is watching.
  //
  // Set UPFRONT_POSTING_ENABLED=true once the combined-watermark model is
  // signed off and the baseline has been seeded.
  if (process.env.UPFRONT_POSTING_ENABLED !== "true") {
    const msg =
      "Upfront posting is gated: set UPFRONT_POSTING_ENABLED=true once the combined-watermark model is signed off and seeded. Nothing was posted.";
    console.warn(JSON.stringify({ event: "commission.upfront.gated", at: new Date().toISOString() }));
    return NextResponse.json({ gated: true, created: 0, evaluated: 0, note: msg });
  }

  const { mStart, mEnd, monthStart, monthEnd } = await resolveMonth(req);

  const result = await runUpfront(mStart, mEnd, mEnd);

  console.log(
    JSON.stringify({
      event: "commission.run",
      type: "monthly-upfront",
      monthStart,
      monthEnd,
      ...result,
      at: new Date().toISOString(),
    }),
  );

  return NextResponse.json({
    created: result.created,
    evaluated: result.evaluated,
    totalUpfront: result.totalUpfront,
    month: { monthStart, monthEnd },
  });
}

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}
