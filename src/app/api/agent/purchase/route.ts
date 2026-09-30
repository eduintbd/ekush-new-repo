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
import { finalizeKycUpload, uploadKycFile, KycUploadError } from "@/lib/kyc-upload";
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

  // Two shapes accepted, on purpose.
  //
  //   JSON      — the browser already put both documents in kyc-inbox/ and
  //               sends only their keys. This is what the form does now, and
  //               it is why a dropped connection costs one small file rather
  //               than the whole order.
  //   multipart — the files ride in this request, as they used to.
  //
  // The old shape stays supported so a browser tab left open on the previous
  // bundle keeps working, and so a rollback is client-side only. Neither path
  // is trusted more than the other: both go through the identical magic-byte,
  // size, PDF-allowlist and sharp re-encode gate below.
  type Ref = { key: string; name: string };
  let investorCode: string;
  let fundCode: string;
  let amount: number;
  let slip: File | null = null;
  let instruction: File | null = null;
  let slipRef: Ref | null = null;
  let instructionRef: Ref | null = null;

  if ((req.headers.get("content-type") ?? "").includes("application/json")) {
    const body = (await req.json().catch(() => ({}))) as {
      investorCode?: string;
      fundCode?: string;
      amount?: unknown;
      documents?: { paymentSlip?: Ref; instruction?: Ref };
    };
    investorCode = String(body.investorCode ?? "").trim();
    fundCode = String(body.fundCode ?? "").trim();
    amount = Number(body.amount ?? 0);
    slipRef = body.documents?.paymentSlip ?? null;
    instructionRef = body.documents?.instruction ?? null;
  } else {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return NextResponse.json({ error: "Invalid form submission." }, { status: 400 });
    }
    investorCode = String(form.get("investorCode") ?? "").trim();
    fundCode = String(form.get("fundCode") ?? "").trim();
    amount = Number(form.get("amount") ?? "0");
    const s1 = form.get("paymentSlip");
    const s2 = form.get("instruction");
    slip = s1 instanceof File && s1.size > 0 ? s1 : null;
    instruction = s2 instanceof File && s2.size > 0 ? s2 : null;
  }

  if (!slip && !slipRef) {
    return NextResponse.json({ error: "The bank deposit slip is required." }, { status: 400 });
  }
  if (!instruction && !instructionRef) {
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
    const slipUp = slipRef
      ? await finalizeKycUpload(slipRef.key, {
          investorId,
          docType: "PAYMENT_SLIP",
          pathPrefix: "payment-slips",
          displayName: slipRef.name,
        })
      : await uploadKycFile(slip as File, {
          investorId,
          docType: "PAYMENT_SLIP",
          pathPrefix: "payment-slips",
        });
    paymentSlipPath = slipUp.filePath;

    const insUp = instructionRef
      ? await finalizeKycUpload(instructionRef.key, {
          investorId,
          docType: "AGENT_PURCHASE_INSTRUCTION",
          displayName: instructionRef.name,
        })
      : await uploadKycFile(instruction as File, {
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
