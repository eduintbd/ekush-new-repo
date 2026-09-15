// POST /api/agent/investors/upload-url — mint a one-time signed URL so the
// browser uploads one KYC document straight to the private kyc-documents
// bucket, instead of bundling all nine into the registration POST.
//
// WHY THIS EXISTS. Agents were losing whole registrations to "Failed to
// fetch". The form sent nine files as ONE multipart POST through Vercel, which
// had to arrive complete or not at all; on a Bangladeshi mobile link that
// single long upload is the fragile part, and one interruption cost every
// field and every file. It failed at 291 KB — size was never the issue, the
// all-or-nothing delivery was.
//
// Investors registering themselves on the portal never hit this, because the
// portal already solved it exactly this way (see its
// /api/auth/register/blob-upload): compress in the browser, send each file
// direct to storage, then post JSON carrying only the keys. This is that
// pattern brought over to the agent flow. A dropped connection now costs one
// small file, retried on its own, instead of the whole registration.
//
// Unlike the portal's version this one is NOT public: agent onboarding is
// behind a login, so the agent session is required. The real content gate is
// still server-side — finalizeKycUpload() reads each file back, magic-byte
// checks it, re-encodes through sharp and writes the sanitized copy. Files
// here land under `kyc-inbox/` and are deleted once finalized, so an
// unsanitized upload never persists.

import { randomUUID } from "crypto";
import type { NextRequest } from "next/server";
import { getAgentScope } from "@/lib/agent-scope";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const preferredRegion = "hnd1";

const BUCKET = "kyc-documents";

export async function POST(req: NextRequest) {
  const scope = await getAgentScope();
  if (!scope.agentId) {
    return Response.json(
      { ok: false, error: "Your account is not linked to an agent record." },
      { status: 403 },
    );
  }

  const body = await req.json().catch(() => ({}) as { name?: string });
  // The name is used for the extension denylist and the admin-facing label
  // only; it never decides what the file is. Strip anything path-like so it
  // cannot climb out of the folder it is given.
  const safe =
    String(body?.name ?? "file")
      .replace(/[^\w.\-]/g, "_")
      .slice(0, 80) || "file";

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return Response.json(
      { ok: false, error: "Storage is not configured on this deployment." },
      { status: 500 },
    );
  }

  // A UUID segment per file: two agents uploading "NID Front Image.jpg" at the
  // same moment must not collide, and a key must not be guessable.
  const path = `kyc-inbox/${randomUUID()}/${safe}`;
  const { data, error } = await admin.storage.from(BUCKET).createSignedUploadUrl(path);
  if (error || !data) {
    console.error("[agent/investors/upload-url] signed url failed", error);
    return Response.json(
      { ok: false, error: "Could not authorize the upload. Try again." },
      { status: 500 },
    );
  }

  return Response.json({ ok: true, path: data.path, token: data.token });
}
