// POST /api/agent/sell
// A selling agent places a SELL (redemption) on behalf of an investor they
// sourced. Same rules and the same rows as the investor's own sell in the
// portal — see lib/agent-sell.ts. A non-demat sale lands on
// portal.ekushwml.com/admin/approvals; a BO sale lands on
// /admin/bo-withdrawals until its DP-40 is uploaded.
//
// multipart/form-data: the client's written authorisation to sell rides along
// and is mandatory — it is the agent's authority to act for the investor.
//
// Nothing is emailed or WhatsApped. The portal messages the investor only when
// an admin approves the order.

import { NextResponse } from "next/server";
import { getAgentScope } from "@/lib/agent-scope";
import { finalizeKycUpload, uploadKycFile, KycUploadError } from "@/lib/kyc-upload";
import { listPurchaseInvestors } from "@/lib/agent-purchase";
import { createAgentSell, newSellOrderId, SellValidationError } from "@/lib/agent-sell";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request): Promise<NextResponse> {
  const scope = await getAgentScope();
  if (!scope.agentId) {
    return NextResponse.json({ error: "Not linked to an agent record." }, { status: 403 });
  }

  // JSON (browser already put the authorisation in kyc-inbox/ and sends the
  // key) or multipart (the file rides along, as it used to). Both are gated
  // identically below; the old shape stays so a stale open tab still works.
  type Ref = { key: string; name: string };
  let investorCode: string;
  let fundCode: string;
  let units: number;
  let instruction: File | null = null;
  let instructionRef: Ref | null = null;

  if ((req.headers.get("content-type") ?? "").includes("application/json")) {
    const body = (await req.json().catch(() => ({}))) as {
      investorCode?: string;
      fundCode?: string;
      units?: unknown;
      documents?: { instruction?: Ref };
    };
    investorCode = String(body.investorCode ?? "").trim();
    fundCode = String(body.fundCode ?? "").trim().toUpperCase();
    units = Number(body.units ?? 0);
    instructionRef = body.documents?.instruction ?? null;
  } else {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return NextResponse.json({ error: "Invalid form submission." }, { status: 400 });
    }
    investorCode = String(form.get("investorCode") ?? "").trim();
    fundCode = String(form.get("fundCode") ?? "").trim().toUpperCase();
    units = Number(form.get("units") ?? "0");
    const f = form.get("instruction");
    instruction = f instanceof File && f.size > 0 ? f : null;
  }

  if (!instruction && !instructionRef) {
    return NextResponse.json(
      { error: "The client's written authorisation to sell is required." },
      { status: 400 },
    );
  }

  // Same permitted set as Buy Fund, re-derived server-side.
  const allowed = await listPurchaseInvestors({ agentCode: scope.agentCode, linkedCodes: scope.codes });
  const allowedCodes = new Set(allowed.map((a) => a.investorCode));
  // Ownership before any upload, so a probe for someone else's investor never
  // leaves a file behind.
  if (!allowedCodes.has(investorCode)) {
    return NextResponse.json({ error: `${investorCode} is not one of your investors.` }, { status: 403 });
  }
  const investorId = allowed.find((a) => a.investorCode === investorCode)!.investorId;

  // The order id is fixed first so the authorisation is filed under it — that
  // filing is how a later cancel knows this agent placed the order.
  const orderId = newSellOrderId();
  let upload: { filePath: string; fileName: string; mimeType: string };
  try {
    const up = instructionRef
      ? await finalizeKycUpload(instructionRef.key, {
          investorId,
          docType: "AGENT_SELL_INSTRUCTION",
          pathPrefix: `agent-sell/${orderId}`,
          displayName: instructionRef.name,
        })
      : await uploadKycFile(instruction as File, {
          investorId,
          docType: "AGENT_SELL_INSTRUCTION",
          pathPrefix: `agent-sell/${orderId}`,
        });
    upload = { filePath: up.filePath, fileName: up.displayName, mimeType: up.storedMimeType };
  } catch (e) {
    if (e instanceof KycUploadError) {
      return NextResponse.json({ ok: false, error: e.message }, { status: e.status });
    }
    console.error("[agent-sell] upload failed", e);
    return NextResponse.json(
      { ok: false, error: "The authorisation could not be uploaded. Try a different scan." },
      { status: 500 },
    );
  }

  try {
    const result = await createAgentSell(
      { orderId, investorCode, fundCode, units, agentCode: scope.agentCode, instruction: upload },
      allowedCodes,
    );
    return NextResponse.json({
      ok: true,
      ...result,
      message: result.requiresBoWithdrawal
        ? "The sell order is placed but not yet executed. The investor signs the BO Units Withdrawal form and sends it to their DP/broker. Once the broker returns the DP-40 report, upload it here (or the investor uploads it in their portal) — without the DP-40 the sale will not be executed."
        : "Redemption order received. After the office approves it, settlement happens within 03 (three) business days.",
    });
  } catch (err) {
    if (err instanceof SellValidationError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: err.status });
    }
    console.error("[agent-sell] create failed", err);
    return NextResponse.json(
      { ok: false, error: "Could not submit the order. Please try again." },
      { status: 500 },
    );
  }
}
