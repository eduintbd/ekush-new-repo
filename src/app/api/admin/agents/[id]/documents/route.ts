// POST /api/admin/agents/[id]/documents — admin uploads a selling agent's
// profile documents (registration form, cheque leaf, photo, NID, nominee
// photo + NID). Multipart, so this is an API route rather than a server
// action, matching api/agent/investors/create.
//
// Files run through the same hardened pipeline as investor KYC
// (uploadKycFile): filename denylist, magic-byte sniff, size caps, PDF
// allowlist, sharp re-encode stripping EXIF. They land in the private
// `kyc-documents` bucket under `agents/<agentId>/<uuid>`.

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { prisma, withActor } from "@/lib/prisma";
import { KycUploadError, uploadKycFile } from "@/lib/kyc-upload";
import { AGENT_DOC_TYPES, AGENT_PDF_ALLOWED, isAgentDocType } from "@/lib/agent-documents";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const me = await requireRole(["admin", "checker"]);
  const { id: agentId } = await params;

  const agent = await prisma.sellingAgent.findUnique({
    where: { id: agentId },
    select: { id: true },
  });
  if (!agent) {
    return NextResponse.json({ error: "Agent not found." }, { status: 404 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected a multipart form upload." }, { status: 400 });
  }

  // One request may carry several documents: any field named after a
  // known doc type is uploaded. Empty file inputs are skipped so the
  // admin can fill in only the parts they have on hand.
  const pending: Array<{ type: string; file: File }> = [];
  for (const type of AGENT_DOC_TYPES) {
    for (const value of form.getAll(type)) {
      if (value instanceof File && value.size > 0) pending.push({ type, file: value });
    }
  }

  if (pending.length === 0) {
    return NextResponse.json({ error: "Choose at least one file to upload." }, { status: 400 });
  }

  // Upload everything BEFORE writing any rows: a rejected file (wrong
  // type, too large) then leaves no half-saved document set behind.
  const uploaded: Array<{ type: string; fileName: string; filePath: string; mimeType: string }> = [];
  try {
    for (const { type, file } of pending) {
      if (!isAgentDocType(type)) continue;
      const result = await uploadKycFile(file, {
        investorId: agentId,
        docType: type,
        pathPrefix: "agents",
        pdfAllowedKinds: AGENT_PDF_ALLOWED,
      });
      uploaded.push({
        type,
        fileName: result.displayName,
        filePath: result.filePath,
        mimeType: result.storedMimeType,
      });
    }
  } catch (err) {
    if (err instanceof KycUploadError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  await withActor(me.id, (tx) =>
    tx.agentDocument.createMany({
      data: uploaded.map((u) => ({ agentId, ...u, uploadedBy: me.id })),
    }),
  );

  return NextResponse.json({ ok: true, count: uploaded.length });
}
