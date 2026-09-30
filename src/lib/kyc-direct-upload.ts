// Browser-side KYC upload: shrink a document, then send it STRAIGHT to the
// private kyc-documents bucket, returning the key the submission references.
//
// Lifted out of the agent onboarding form so Buy Fund and Sell can use the
// identical path, and given the one thing it was missing.
//
// WHY THE RETRY. Onboarding sends nine documents one at a time and each used
// to get exactly ONE attempt, while the final few-kilobyte JSON POST retried
// three times. That is backwards: the uploads run first, carry far more bytes,
// and are on the wire far longer, so they are where a weak mobile link
// actually breaks. On 2026-09-30 agent BI0000 got five documents up, lost the
// connection, and the whole registration died with "Photograph could not be
// uploaded (Failed to fetch)" — the photograph being blameless, merely first
// in the queue. One blip should cost one retry, not a registration.
//
// A 4xx is never retried. An expired session or a rejected file will not fix
// itself on a second go, and retrying only delays telling the agent the truth.

import { createClient } from "@supabase/supabase-js";
import { compressImage } from "@/lib/image-compress";

/** Key + display name of a document already safely in storage. */
export type UploadedRef = { key: string; name: string };

// Anonymous client, used only to PUT at a signed URL the server minted. No
// session and no service key ever reach the browser; the token is single-use
// and scoped to one object key.
const storage = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
  { auth: { persistSession: false, autoRefreshToken: false } },
);

// Matches SEND_ATTEMPTS / RETRY_BACKOFF_MS on the registration POST, so both
// halves of a submit behave the same way under the same bad connection.
export const UPLOAD_ATTEMPTS = 3;
const BACKOFF_MS = [800, 2500];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Thrown when an attempt fails; `retryable` decides whether to try again. */
class AttemptError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

/** Abort rather than hang for ever if a single upload stalls. */
async function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AttemptError(message, true)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/** One go at authorise-then-PUT. Throws AttemptError. */
async function attemptUpload(small: File): Promise<UploadedRef> {
  let res: Response;
  try {
    res = await withTimeout(
      fetch("/api/agent/kyc/upload-url", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: small.name }),
      }),
      30_000,
      "authorization timed out",
    );
  } catch (err) {
    if (err instanceof AttemptError) throw err;
    // A TypeError here is the browser's "Failed to fetch" — the connection,
    // not the server. Always worth another go.
    throw new AttemptError(err instanceof Error ? err.message : "network error", true);
  }

  const auth = await res.json().catch(() => ({}) as { ok?: boolean; error?: string });
  if (!res.ok || !auth?.ok) {
    // 4xx is a verdict (signed out, not an agent, bad name) — do not retry it.
    // 5xx is the server having a moment, which a retry may well survive.
    throw new AttemptError(
      auth?.error ?? "could not authorize the upload",
      res.status >= 500,
    );
  }

  const up = await withTimeout(
    storage.storage
      .from("kyc-documents")
      .uploadToSignedUrl(auth.path, auth.token, small, { contentType: small.type || undefined }),
    120_000,
    "upload timed out",
  );
  if (up.error) {
    // supabase-js reports a dead connection as StorageUnknownError carrying the
    // browser's own "Failed to fetch", with no status. Anything with a 4xx
    // status is the storage layer refusing the file, which will refuse it again.
    const status = (up.error as { status?: number }).status;
    throw new AttemptError(
      up.error.message || "upload failed",
      !(typeof status === "number" && status >= 400 && status < 500),
    );
  }

  return { key: auth.path as string, name: small.name };
}

/**
 * Shrink and upload one document, retrying a dropped connection.
 *
 * `onAttempt` fires before each try after the first, so a form can say
 * "Connection dropped — retrying (2 of 3)…" instead of looking frozen.
 */
export async function uploadKycDocument(
  file: File,
  onAttempt?: (attempt: number, total: number) => void,
): Promise<UploadedRef> {
  const small = await compressImage(file);

  let last: AttemptError | null = null;
  for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt++) {
    if (attempt > 1) onAttempt?.(attempt, UPLOAD_ATTEMPTS);
    try {
      return await attemptUpload(small);
    } catch (err) {
      last = err instanceof AttemptError ? err : new AttemptError(String(err), true);
      if (!last.retryable || attempt === UPLOAD_ATTEMPTS) break;
      await sleep(BACKOFF_MS[attempt - 1] ?? 2500);
    }
  }
  throw new Error(
    last?.retryable
      ? `${last.message} — tried ${UPLOAD_ATTEMPTS} times`
      : (last?.message ?? "upload failed"),
  );
}
