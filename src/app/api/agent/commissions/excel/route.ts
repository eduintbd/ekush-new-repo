// GET /api/agent/commissions/excel
// The signed-in selling agent's own commission workbook — same sheets as the
// admin download, built with `audience: "agent"` so the Terms sheet omits our
// internal data-quality flags and the Summary header omits internal table
// names.
//
// Agent-scoped with no route parameter: the agent id comes from the session
// via getAgentScope(), so there is nothing to tamper with. Same pattern as
// /api/agent/statements.

import { type NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAgentScope } from "@/lib/agent-scope";
import { computeAgentCommissionPreview, parseAsOf } from "@/lib/agent-commission-preview";
import { listAgentPayments } from "@/lib/commission-payout";
import { buildAgentCommissionWorkbook } from "@/lib/agent-commission-workbook";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest): Promise<NextResponse | Response> {
  const scope = await getAgentScope();
  if (!scope.agentId) {
    return new Response("Not linked to an agent record.", { status: 403 });
  }

  // ?asOf=YYYY-MM-DD, same as the admin route. This handler used to take no
  // argument at all, so no query string could reach it and the agent's file was
  // always live-to-this-instant — meaning it could never be reconciled against
  // the period the office actually billed and paid. `parseAsOf` clamps future
  // dates and falls back to today on anything unparseable, and the agent id
  // still comes from the session, so exposing this adds no scope to tamper with.
  const asOf = parseAsOf(req.nextUrl.searchParams.get("asOf"));

  const [preview, payments] = await Promise.all([
    computeAgentCommissionPreview(prisma, scope.agentId, asOf),
    listAgentPayments(scope.agentId),
  ]);
  const buf = await buildAgentCommissionWorkbook(preview, { audience: "agent", payments });
  const filename = `my-commissions-${preview.agentCode}-${preview.asOf.toISOString().slice(0, 10)}.xlsx`;

  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
