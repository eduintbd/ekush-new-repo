// Refresh Supabase session on every request. Without this, server components
// see a stale auth state after the access token rotates. Pattern from
// https://supabase.com/docs/guides/auth/server-side/nextjs.
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import {
  authTimeoutFetch,
  isAuthUnavailable,
  withAuthDeadline,
} from "@/lib/supabase/resilience";

/** The parts of the user the middleware reads. */
export type MiddlewareUser = { id: string; user_metadata: Record<string, unknown> };

export async function updateSupabaseSession(req: NextRequest) {
  let res = NextResponse.next({ request: req });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) {
    // Auth not configured — let the request through; pages render their
    // "Auth not configured" empty state. No session refresh possible.
    return { res, user: null as null, authUnavailable: false };
  }

  const supabase = createServerClient(supabaseUrl, supabaseKey, {
    // A hung auth service must fail in seconds, not hold the function open
    // until the gateway times out. See @/lib/supabase/resilience.
    global: { fetch: authTimeoutFetch() },
    cookies: {
      getAll() {
        return req.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => req.cookies.set(name, value));
        res = NextResponse.next({ request: req });
        cookiesToSet.forEach(({ name, value, options }) =>
          res.cookies.set(name, value, options),
        );
      },
    },
  });

  // `authUnavailable` is deliberately separate from `user: null`: signed-out
  // and "the auth service is wedged" call for different responses, and the
  // caller can't tell them apart from a null user alone.
  //
  // Link prefetches (Next pre-loads visible links) verify the JWT locally
  // with getClaims() instead of a getUser() round trip to Supabase Auth; the
  // click that follows is a real navigation and gets the full check. The page
  // guards in @/lib/auth still gate whatever a prefetch renders.
  const isPrefetch =
    req.headers.get("next-router-prefetch") === "1" || req.headers.get("purpose") === "prefetch";
  if (isPrefetch) {
    const result = await withAuthDeadline(supabase.auth.getClaims());
    if (result.status === "timeout") return { res, user: null, authUnavailable: true };
    if (result.status === "error") {
      if (!isAuthUnavailable(result.error)) throw result.error;
      return { res, user: null, authUnavailable: true };
    }
    const { data, error } = result.value;
    const claims = data?.claims;
    const user: MiddlewareUser | null = claims
      ? { id: claims.sub, user_metadata: (claims.user_metadata ?? {}) as Record<string, unknown> }
      : null;
    return { res, user, authUnavailable: !user && isAuthUnavailable(error) };
  }

  const result = await withAuthDeadline(supabase.auth.getUser());
  if (result.status === "timeout") return { res, user: null, authUnavailable: true };
  if (result.status === "error") {
    if (!isAuthUnavailable(result.error)) throw result.error;
    return { res, user: null, authUnavailable: true };
  }

  const { data, error } = result.value;
  const user: MiddlewareUser | null = data.user
    ? { id: data.user.id, user_metadata: (data.user.user_metadata ?? {}) as Record<string, unknown> }
    : null;
  return {
    res,
    user,
    authUnavailable: !user && isAuthUnavailable(error),
  };
}
