// GET /api/agent/commissions/excel
// The signed-in selling agent's own commission workbook — same sheets as the
// admin download, built with `audience: "agent"` so the Terms sheet omits our
// internal data-quality flags and the Summary header omits internal table
// names.
//
// Agent-scoped with no route parameter: the agent id comes from the session
// via getAgentScope(), so there is nothing to tamper with. Same pattern as
// /api/agent/statements.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAgentScope } from "@/lib/agent-scope";
import { computeAgentCommissionPreview } from "@/lib/agent-commission-preview";
import { buildAgentCommissionWorkbook } from "@/lib/agent-commission-workbook";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<NextResponse | Response> {
  const scope = await getAgentScope();
  if (!scope.agentId) {
    return new Response("Not linked to an agent record.", { status: 403 });
  }

  const preview = await computeAgentCommissionPreview(prisma, scope.agentId);
  const buf = await buildAgentCommissionWorkbook(preview, { audience: "agent" });
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
