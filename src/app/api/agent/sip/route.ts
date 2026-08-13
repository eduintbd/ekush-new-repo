// POST /api/agent/sip
// A selling agent raises a SIP instruction on behalf of an investor they
// sourced. The plan lands in the PORTAL's tables and appears on
// portal.ekushwml.com/admin/approvals alongside investor-raised ones.
//
// Agent-scoped with no route parameter: the agent id comes from the session via
// getAgentScope(), and the investor must be inside that scope's code set, so
// the investorCode in the body cannot be used to reach somebody else's client.
// Same pattern as /api/agent/commissions/excel and /api/agent/investors/create.

import { NextResponse } from "next/server";
import { getAgentScope } from "@/lib/agent-scope";
import { createAgentSip, SipValidationError } from "@/lib/agent-sip";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request): Promise<NextResponse> {
  const scope = await getAgentScope();
  if (!scope.agentId) {
    return NextResponse.json({ error: "Not linked to an agent record." }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  try {
    const result = await createAgentSip(
      {
        investorCode: String(body.investorCode ?? "").trim(),
        fundCode: String(body.fundCode ?? "").trim(),
        amount: Number(body.amount),
        tenure: Number(body.tenure),
        debitDay: Number(body.debitDay),
        bankAccountId: body.bankAccountId ? String(body.bankAccountId) : null,
        agentCode: scope.agentCode,
      },
      scope.codeSet,
    );
    return NextResponse.json({
      ok: true,
      sipPlanId: result.sipPlanId,
      status: "PENDING_APPROVAL",
      startDate: result.startDate.toISOString().slice(0, 10),
      endDate: result.endDate.toISOString().slice(0, 10),
      message: "SIP submitted. It is now awaiting approval by the office.",
    });
  } catch (err) {
    if (err instanceof SipValidationError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[agent-sip] create failed", err);
    return NextResponse.json({ error: "Could not submit the SIP. Please try again." }, { status: 500 });
  }
}
