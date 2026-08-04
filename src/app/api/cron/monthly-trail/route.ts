// GET / POST /api/cron/monthly-trail
//
// REPORTS ONLY — THIS CRON NEVER WRITES.
//
// Computes trail for every approved agent from the SAME preview engine behind
// /agent/earnings and /admin/agents/[id], and reports what is due. Posting is
// the accountant's act: they set the billing cut-off on /admin/agents/[id] and
// click "Post trail to CommissionRun", which attributes the rows to them.
//
// It used to post, and on 2026-08-01 at 03:01 UTC it wrote 189 rows
// (BDT 3,078.93) unattended with a NULL actor. `dryRun` is now hardcoded true
// rather than read from `?dryRun=1`, so the writing path cannot be reached by
// changing a query string.
//
// It still evaluates EVERY completed period, not just last month's, which is
// what makes the report self-healing: a month nobody acted on still shows up
// in the next report rather than disappearing. The preview marks the in-flight
// period `partial` and it is skipped, so one monthly job serves both the
// monthly and quarterly cadences.
//
// The schedule stays so an unbilled month is visible in the log drain as
// `commission.trail.preview` with a non-zero figure.
//
// Auth: `Authorization: Bearer $CRON_SECRET` (Vercel Cron) or
// `x-cron-secret: $CRON_SECRET` (manual / external scheduler).
//
// Schedule: 03:00 UTC on the 1st of every month via vercel.json.

import { NextResponse, type NextRequest } from "next/server";
import { postTrailFromPreview } from "@/lib/post-trail";
import { authoriseCron } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

async function handle(req: NextRequest) {
  if (!authoriseCron(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Hardcoded, not from `?dryRun=`. No request can make this job write.
  const result = await postTrailFromPreview({ actorId: null, dryRun: true });

  console.log(
    JSON.stringify({
      event: "commission.trail.preview",
      source: "cron/monthly-trail",
      posted: false,
      note: "reported only — the accountant posts from /admin/agents/[id]",
      ...result,
      at: new Date().toISOString(),
    }),
  );

  // A partial failure or a refused overlap must NOT look like a green run —
  // this is money, and a 200 here is how a problem stays invisible for months.
  const unhealthy = result.agentsFailed > 0 || result.overlapConflicts > 0;
  return NextResponse.json(result, { status: unhealthy ? 500 : 200 });
}

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}
