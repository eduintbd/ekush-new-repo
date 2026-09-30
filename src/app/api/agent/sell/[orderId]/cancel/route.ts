// POST /api/agent/sell/[orderId]/cancel
// The agent cancels a BO sell they placed, while it still awaits its DP-40.
// Same effect as the investor's own cancel in the portal — see cancelAgentSell.

import { NextResponse } from "next/server";
import { getAgentScope } from "@/lib/agent-scope";
import { listPurchaseInvestors } from "@/lib/agent-purchase";
import { cancelAgentSell, SellValidationError } from "@/lib/agent-sell";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  _req: Request,
  { params }: { params: { orderId: string } },
): Promise<NextResponse> {
  const scope = await getAgentScope();
  if (!scope.agentId) {
    return NextResponse.json({ error: "Not linked to an agent record." }, { status: 403 });
  }
  const allowed = await listPurchaseInvestors({ agentCode: scope.agentCode, linkedCodes: scope.codes });
  const allowedCodes = new Set(allowed.map((a) => a.investorCode));

  try {
    const { wasMarkedSold } = await cancelAgentSell(
      { orderId: params.orderId, agentCode: scope.agentCode },
      allowedCodes,
    );
    return NextResponse.json({
      ok: true,
      status: "CANCELLED",
      message: wasMarkedSold
        ? "Sell order cancelled and the units released. The accounts team had already booked this sale, so contact the office to confirm the reversal."
        : "Sell order cancelled.",
    });
  } catch (err) {
    if (err instanceof SellValidationError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: err.status });
    }
    console.error("[agent-sell cancel] failed", err);
    return NextResponse.json({ ok: false, error: "Could not cancel. Please try again." }, { status: 500 });
  }
}
