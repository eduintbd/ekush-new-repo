// GET / POST /api/cron/link-agent-investors
// Creates xsystem.agent_investors links for agent-sourced investors who have
// since invested (a BUY exists), so the agent's list + the commission engine
// pick them up. Idempotent. Auth: shared-secret (Bearer $CRON_SECRET or
// x-cron-secret). Schedule daily via vercel.json crons.

import { NextResponse, type NextRequest } from "next/server";
import { authoriseCron } from "@/lib/cron-auth";
import { reconcileAgentInvestorLinks } from "@/lib/agent-sourced";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function handle(req: NextRequest) {
  if (!authoriseCron(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await reconcileAgentInvestorLinks();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "reconcile failed" },
      { status: 500 },
    );
  }
}

export const GET = handle;
export const POST = handle;
