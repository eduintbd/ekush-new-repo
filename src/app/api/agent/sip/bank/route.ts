// POST /api/agent/sip/bank
// Register an additional bank account for an investor the agent sourced, so a
// SIP mandate has a debit account to point at.
//
// Mirrors the portal's inline add-bank on /sip: the row is written
// PENDING_APPROVAL, never ACTIVE, and the investor's NID scan is MANDATORY —
// the admin matches the account-holder name against that NID before approving.
// An agent submitting bank details on a client's behalf is exactly the case
// that gate exists for, so it is enforced here rather than trusted to the UI.
//
// Multipart, not JSON, because of the file parts. Files go to the same private
// `kyc-documents` bucket the portal reads from, via the shared hardened
// uploader (magic-byte sniffing, size caps, EXIF-stripping re-encode).

import { NextResponse } from "next/server";
import { getAgentScope } from "@/lib/agent-scope";
import { addInvestorBank, SipValidationError } from "@/lib/agent-sip";
import { KycUploadError, uploadKycFile } from "@/lib/kyc-upload";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const s = (form: FormData, key: string) => String(form.get(key) ?? "").trim();

export async function POST(req: Request): Promise<NextResponse> {
  const scope = await getAgentScope();
  if (!scope.agentId) {
    return NextResponse.json({ error: "Not linked to an agent record." }, { status: 403 });
  }

  const form = await req.formData();
  const investorCode = s(form, "investorCode");
  if (!scope.codeSet.has(investorCode)) {
    return NextResponse.json({ error: `${investorCode} is not one of your investors.` }, { status: 403 });
  }

  // Resolve the investor id first: the storage key is keyed on it, so the file
  // cannot be uploaded before the code is known to be real and in scope.
  const inv = (
    await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM public.investors WHERE "investorCode" = $1 LIMIT 1`,
      investorCode,
    )
  )[0];
  if (!inv) {
    return NextResponse.json({ error: `Investor ${investorCode} not found.` }, { status: 404 });
  }

  const nid = form.get("nidImage");
  if (!(nid instanceof File) || nid.size === 0) {
    return NextResponse.json(
      { error: "The investor's NID scan is required. The name on it must match the bank account name." },
      { status: 400 },
    );
  }

  // Uploads before DB writes — a rejected file aborts with nothing written, and
  // an orphaned object in storage is harmless.
  let nidImageUrl: string;
  let chequeLeafUrl: string | null = null;
  try {
    nidImageUrl = (await uploadKycFile(nid, { investorId: inv.id, docType: "NID_FRONT" })).filePath;
    const cheque = form.get("chequeLeaf");
    if (cheque instanceof File && cheque.size > 0) {
      chequeLeafUrl = (await uploadKycFile(cheque, { investorId: inv.id, docType: "CHEQUE_LEAF_PHOTO" })).filePath;
    }
  } catch (e) {
    if (e instanceof KycUploadError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    console.error("[agent-sip] bank upload failed", e);
    return NextResponse.json({ error: "A file failed to upload." }, { status: 500 });
  }

  try {
    const { bankAccountId } = await addInvestorBank(
      {
        investorCode,
        bankName: s(form, "bankName"),
        accountNumber: s(form, "accountNumber"),
        branchName: s(form, "branchName") || null,
        routingNumber: s(form, "routingNumber") || null,
        nidImageUrl,
        chequeLeafUrl,
        agentCode: scope.agentCode,
      },
      scope.codeSet,
    );
    return NextResponse.json({
      ok: true,
      bankAccountId,
      message:
        "Bank account submitted for approval. The office must approve it before the SIP mandate can be sent to the bank.",
    });
  } catch (err) {
    if (err instanceof SipValidationError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[agent-sip] bank create failed", err);
    return NextResponse.json({ error: "Could not add the bank account." }, { status: 500 });
  }
}
