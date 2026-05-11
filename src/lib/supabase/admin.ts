// Service-role Supabase client. NEVER call from a Client Component — the
// service-role key bypasses RLS and can do anything. Use this only inside
// server-side actions / route handlers that have already authenticated
// the caller through another mechanism (e.g. a verified MFA recovery code).
//
// Returns null if `SUPABASE_SERVICE_ROLE_KEY` isn't configured, so callers
// can degrade gracefully and surface a "feature disabled" message rather
// than crash.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null = null;

export function createSupabaseAdminClient(): SupabaseClient | null {
  if (cached) return cached;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return null;
  cached = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}

/** True iff the service-role key is configured. UI can hide the recovery-
 * code section when this is false. */
export function adminClientAvailable(): boolean {
  return Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);
}
