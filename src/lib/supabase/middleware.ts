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
  const result = await withAuthDeadline(supabase.auth.getUser());
  if (result.status === "timeout") return { res, user: null, authUnavailable: true };
  if (result.status === "error") {
    if (!isAuthUnavailable(result.error)) throw result.error;
    return { res, user: null, authUnavailable: true };
  }

  const { data, error } = result.value;
  return {
    res,
    user: data.user,
    authUnavailable: !data.user && isAuthUnavailable(error),
  };
}
