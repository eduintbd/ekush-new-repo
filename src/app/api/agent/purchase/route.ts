// POST /api/agent/purchase
// A selling agent places a lump-sum BUY on behalf of an investor they sourced.
// The order lands in the PORTAL's tables and appears on
// portal.ekushwml.com/admin/approvals alongside investor-raised ones.
//
// Agent-scoped with no route parameter: the agent id comes from the session via
// getAgentScope(), and the investor must be inside that scope, so the
// investorCode in the body cannot be used to reach somebody else's client.
// Same pattern as /api/agent/sip and /api/agent/investors/create.
//
// multipart/form-data, because two files ride along: the investor's bank
// deposit slip and the client's written instruction to purchase.

import { NextResponse } from "next/server";
import { getAgentScope } from "@/lib/agent-scope";
import { uploadKycFile, KycUploadError } from "@/lib/kyc-upload";
import {
  createAgentPurchase,
  listPurchaseInvestors,
  PurchaseValidationError,
} from "@/lib/agent-purchase";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request): Promise<NextResponse> {
  const scope = await getAgentScope();
  if (!scope.agentId) {
    return NextResponse.json({ error: "Not linked to an agent record." }, { status: 403 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form submission." }, { status: 400 });
  }

  const investorCode = String(form.get("investorCode") ?? "").trim();
  const fundCode = String(form.get("fundCode") ?? "").trim();
  const amount = Number(form.get("amount") ?? "0");
  const slip = form.get("paymentSlip");
  const instruction = form.get("instruction");

  if (!(slip instanceof File) || slip.size === 0) {
    return NextResponse.json({ error: "The bank deposit slip is required." }, { status: 400 });
  }
  if (!(instruction instanceof File) || instruction.size === 0) {
    return NextResponse.json(
      { error: "The client's written instruction to purchase is required." },
      { status: 400 },
    );
  }

  // Re-derive the permitted investor set server-side rather than trusting the
  // scope's link list alone: this flow deliberately also covers investors the
  // agent onboarded who have no commission link yet.
  const allowed = await listPurchaseInvestors({
    agentCode: scope.agentCode,
    linkedCodes: scope.codes,
  });
  const allowedCodes = new Set(allowed.map((a) => a.investorCode));

  // Ownership is checked before anything is uploaded, so a probe for someone
  // else's investor never leaves a file behind.
  if (!allowedCodes.has(investorCode)) {
    return NextResponse.json(
      { error: `${investorCode} is not one of your investors.` },
      { status: 403 },
    );
  }

  // Resolve the investor id for the storage key. createAgentPurchase re-reads
  // it and is the authority; this is only to file the uploads.
  const investorId = allowed.find((a) => a.investorCode === investorCode)!.investorId;

  let paymentSlipPath: string;
  let instructionUpload: { filePath: string; fileName: string; mimeType: string };
  try {
    const slipUp = await uploadKycFile(slip, {
      investorId,
      docType: "PAYMENT_SLIP",
      pathPrefix: "payment-slips",
    });
    paymentSlipPath = slipUp.filePath;

    const insUp = await uploadKycFile(instruction, {
      investorId,
      docType: "AGENT_PURCHASE_INSTRUCTION",
    });
    instructionUpload = {
      filePath: insUp.filePath,
      fileName: insUp.displayName,
      mimeType: insUp.storedMimeType,
    };
  } catch (e) {
    if (e instanceof KycUploadError) {
      return NextResponse.json({ ok: false, error: e.message }, { status: e.status });
    }
    console.error("[agent-purchase] upload failed", e);
    return NextResponse.json(
      { ok: false, error: "A file could not be uploaded. Try a different scan." },
      { status: 500 },
    );
  }

  try {
    const result = await createAgentPurchase(
      {
        investorCode,
        fundCode,
        amount,
        agentCode: scope.agentCode,
        paymentSlipPath,
        instruction: instructionUpload,
      },
      allowedCodes,
    );
    return NextResponse.json({
      ok: true,
      ...result,
      status: "PENDING",
      message:
        "Order received. After the office approves it, settlement happens within 03 (three) business days.",
    });
  } catch (err) {
    if (err instanceof PurchaseValidationError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: err.status });
    }
    console.error("[agent-purchase] create failed", err);
    return NextResponse.json(
      { ok: false, error: "Could not submit the order. Please try again." },
      { status: 500 },
    );
  }
}
