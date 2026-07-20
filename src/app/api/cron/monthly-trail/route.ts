// GET / POST /api/cron/monthly-trail
//
// Posts trail CommissionRun rows for every approved agent, from the SAME
// preview engine behind /agent/earnings and /admin/agents/[id] — so what this
// writes is what the agent already saw on screen.
//
// It posts EVERY completed period, not just last month's. That is deliberate:
//   - the preview marks the in-flight period `partial` and this skips it, so a
//     quarterly-cadence term is simply left alone until its quarter closes —
//     one monthly job correctly serves both cadences (quarterly-trail is now a
//     no-op);
//   - a missed, failed or unauthorised run self-heals on the next fire instead
//     of losing that period forever;
//   - re-posting is free — the (agent_investor_id, type, period_start,
//     period_end) unique index absorbs anything already written.
//
// No period parameters: both callers let the preview default to `now`, which
// is what keeps cron output identical to the admin button.
//
// Auth: `Authorization: Bearer $CRON_SECRET` (Vercel Cron) or
// `x-cron-secret: $CRON_SECRET` (manual / external scheduler).
// Add `?dryRun=1` to compute and report without writing.
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

  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";
  const result = await postTrailFromPreview({ actorId: null, dryRun });

  console.log(
    JSON.stringify({
      event: "commission.trail.post",
      source: "cron/monthly-trail",
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
