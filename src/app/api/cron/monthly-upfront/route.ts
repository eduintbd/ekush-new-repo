// GET / POST /api/cron/monthly-upfront
//
// REPORTS ONLY — THIS CRON NEVER WRITES.
//
// Evaluates the per-agent BOOK upfront high-water-mark for the just-completed
// month and reports what is due. It does not post. Posting a commission run
// creates an obligation, and that is the accountant's act alone: they set the
// billing cut-off on /admin/agents/[id] and click "Post upfront now", which
// attributes the rows to them in the audit log.
//
// It used to post, behind an UPFRONT_POSTING_ENABLED env gate that was set to
// true in production. On 2026-08-01 at 04:00 UTC it wrote the first five real
// upfront rows unattended, with a NULL actor — nobody chose to pay that money.
// The gate is gone; `dryRun` is now unconditional, so there is no env var that
// can turn writing back on by accident.
//
// The schedule stays so a month that should have been billed still shows up in
// the log drain as `commission.upfront.preview` with a non-zero figure.
//
// Auth: `Authorization: Bearer $CRON_SECRET` (Vercel Cron) or
// `x-cron-secret: $CRON_SECRET` (manual / external scheduler).
//
// Month selection:
//   - GET with no params → just-completed calendar month (Vercel Cron, 1st).
//   - POST `{ monthStart, monthEnd }` body or GET query params → explicit.
//
// Schedule: 04:00 UTC on the 1st of every month via vercel.json.

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

  const { mStart, mEnd, monthStart, monthEnd } = await resolveMonth(req);

  // `dryRun: true` is hardcoded, not read from a query param or an env var.
  // The whole point is that no configuration change can make this job write —
  // the previous env gate was flipped on and posted BDT 2,494.96 unattended.
  // runUpfront computes everything either way and reports `created` /
  // `totalUpfront` as what WOULD post, so the figure below is unchanged.
  const result = await runUpfront(mStart, mEnd, mEnd, { dryRun: true, actorId: null });

  console.log(
    JSON.stringify({
      event: "commission.upfront.preview",
      type: "monthly-upfront",
      posted: false,
      note: "reported only — the accountant posts from /admin/agents/[id]",
      monthStart,
      monthEnd,
      ...result,
      at: new Date().toISOString(),
    }),
  );

  // A blocked investor (missing term, data warning) must not read as a clean
  // run — this is money, and a silent 200 is how a suppressed month hides.
  const unhealthy = result.blocked > 0;
  return NextResponse.json(
    { ...result, month: { monthStart, monthEnd } },
    { status: unhealthy ? 500 : 200 },
  );
}

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}
