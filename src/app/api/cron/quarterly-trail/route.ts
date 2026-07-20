// GET / POST /api/cron/quarterly-trail — SUPERSEDED, intentionally a no-op.
//
// /api/cron/monthly-trail now posts every completed period for BOTH cadences:
// the preview flags the in-flight period `partial`, so a quarterly-cadence
// term is left alone until its quarter closes and then posted by the next
// monthly fire. Keeping this route live and computing the same rows would mean
// two jobs racing on the identical row set four times a year.
//
// The route is kept (rather than deleted) so any external scheduler still
// pointing here gets a 200 with an explanation instead of a 404. It has been
// removed from vercel.json.

import { NextResponse, type NextRequest } from "next/server";
import { authoriseCron } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function handle(req: NextRequest) {
  if (!authoriseCron(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json({
    ok: true,
    posted: 0,
    note: "Superseded by /api/cron/monthly-trail, which posts every completed period for both monthly and quarterly cadences. Nothing to do here.",
  });
}

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}
