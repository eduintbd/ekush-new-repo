// Resolve stored KYC file references (Document.filePath, chequeLeafUrl,
// nidImageUrl, signatureUrl) to short-lived signed URLs. KYC files live in the
// portal's PRIVATE `kyc-documents` Supabase Storage bucket; ekush-erp shares the
// same Supabase project + service-role key, so it can sign them directly (the
// portal's gated /api/documents/[id] proxy is not reachable from this app).
//
// Mirrors the portal's isStorageKey/signedUrl logic (src/lib/storage/index.ts):
// full URLs (legacy Vercel Blob) and app paths pass through unchanged.

import { createSupabaseAdminClient } from "@/lib/supabase/admin";

const BUCKET = "kyc-documents";

function isStorageKey(value: string | null | undefined): value is string {
  return !!value && !value.startsWith("http") && !value.startsWith("/");
}

export async function signedKycUrl(
  value: string | null | undefined,
  ttlSeconds = 300,
): Promise<string | null> {
  if (!value) return null;
  if (!isStorageKey(value)) return value;
  const admin = createSupabaseAdminClient();
  if (!admin) return null;
  const { data, error } = await admin.storage.from(BUCKET).createSignedUrl(value, ttlSeconds);
  if (error || !data) return null;
  return data.signedUrl;
}

/** Resolve many at once, preserving order (null for any that fail). */
export async function signedKycUrls(
  values: Array<string | null | undefined>,
  ttlSeconds = 300,
): Promise<Array<string | null>> {
  return Promise.all(values.map((v) => signedKycUrl(v, ttlSeconds)));
}
