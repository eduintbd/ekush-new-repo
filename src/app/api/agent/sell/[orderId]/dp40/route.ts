// POST /api/agent/sell/[orderId]/dp40
// The agent uploads the broker's DP-40 report for a BO sell of one of their
// investors — the step that moves the order onto the portal's approvals queue.
// The investor can still do the same from their own portal login; whichever
// arrives first moves it (see uploadAgentDp40).

import { NextResponse } from "next/server";
import { getAgentScope } from "@/lib/agent-scope";
import { finalizeKycUpload, uploadKycFile, KycUploadError } from "@/lib/kyc-upload";
import { listPurchaseInvestors } from "@/lib/agent-purchase";
import { checkOpenBoSell, SellValidationError, uploadAgentDp40 } from "@/lib/agent-sell";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(
  req: Request,
  { params }: { params: { orderId: string } },
): Promise<NextResponse> {
  const scope = await getAgentScope();
  if (!scope.agentId) {
    return NextResponse.json({ error: "Not linked to an agent record." }, { status: 403 });
  }

  const allowed = await listPurchaseInvestors({ agentCode: scope.agentCode, linkedCodes: scope.codes });
  const allowedCodes = new Set(allowed.map((a) => a.investorCode));

  // Check before uploading anything.
  let investorId: string;
  try {
    investorId = (await checkOpenBoSell(params.orderId, allowedCodes)).investorId;
  } catch (err) {
    if (err instanceof SellValidationError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: err.status });
    }
    throw err;
  }

  // JSON with a storage key, or the file itself — see the sell route.
  type Ref = { key: string; name: string };
  let file: File | null = null;
  let fileRef: Ref | null = null;
  if ((req.headers.get("content-type") ?? "").includes("application/json")) {
    const body = (await req.json().catch(() => ({}))) as { documents?: { dp40?: Ref } };
    fileRef = body.documents?.dp40 ?? null;
  } else {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return NextResponse.json({ error: "Invalid form submission." }, { status: 400 });
    }
    const f = form.get("dp40");
    file = f instanceof File && f.size > 0 ? f : null;
  }
  if (!file && !fileRef) {
    return NextResponse.json({ ok: false, error: "DP-40 report file required" }, { status: 400 });
  }

  let up: { filePath: string; fileName: string; mimeType: string };
  try {
    const r = fileRef
      ? await finalizeKycUpload(fileRef.key, {
          investorId,
          docType: "DP40",
          pathPrefix: "dp40",
          displayName: fileRef.name,
        })
      : await uploadKycFile(file as File, { investorId, docType: "DP40", pathPrefix: "dp40" });
    up = { filePath: r.filePath, fileName: r.displayName, mimeType: r.storedMimeType };
  } catch (e) {
    if (e instanceof KycUploadError) {
      return NextResponse.json({ ok: false, error: e.message }, { status: e.status });
    }
    console.error("[agent-sell dp40] upload failed", e);
    return NextResponse.json({ ok: false, error: "The DP-40 could not be uploaded." }, { status: 500 });
  }

  try {
    await uploadAgentDp40({ orderId: params.orderId, agentCode: scope.agentCode, file: up }, allowedCodes);
  } catch (err) {
    if (err instanceof SellValidationError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: err.status });
    }
    console.error("[agent-sell dp40] failed", err);
    return NextResponse.json({ ok: false, error: "Could not record the DP-40. Please try again." }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    status: "PENDING",
    message: "DP-40 report received. The sell order is now on the office's approvals queue.",
  });
}
