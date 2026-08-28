// Guard rails for Supabase Auth (GoTrue) outages.
//
// X-System shares Supabase project `sqgxqzzkggzcqhtaoham` with the investor
// portal, so one GoTrue outage takes both down at once — staff, accountants
// and every selling agent along with the 1,000+ investors.
//
// 2026-08-28 incident: GoTrue stopped answering while Postgres, PostgREST
// and Storage stayed healthy. Every gated route calls supabase.auth.getUser()
// in the middleware AND again in the page guard, with no timeout, so each
// request hung until the gateway gave up ~100s later and served a "Gateway
// time-out 504". Worse here than on the portal: signInAgent/signInStaff turn
// any sign-in failure into "Invalid email or password", so an outage tells
// agents their password is wrong.
//
// Two rules come out of that:
//   1. Never wait indefinitely on the auth service — fail in seconds.
//   2. "Auth is down" is not "you are signed out" and not "wrong password".
//      Say so plainly.
//
// Mirrors apps/portal/src/lib/supabase/resilience.ts in the ekushwml repo —
// keep the two in step.

/** How long an auth call may take before we give up. */
export const AUTH_TIMEOUT_MS = 5_000;

/** Longer budget for service-role auth admin calls, which do more work. */
export const AUTH_ADMIN_TIMEOUT_MS = 8_000;

/**
 * Hard ceiling on a whole auth operation, retries included.
 *
 * A per-request timeout alone is not enough: on the token-refresh path
 * supabase-js retries a failing call for up to 30 seconds (its
 * AUTO_REFRESH_TICK_DURATION), so an unreachable GoTrue still parked the
 * request for ~28s in testing. This bounds the entire call.
 */
export const AUTH_DEADLINE_MS = 6_000;

/** Shown to users when GoTrue is unreachable. Plain, no blame, actionable. */
export const AUTH_UNAVAILABLE_MESSAGE =
  "Sign-in is temporarily unavailable — the authentication service is not responding. Your password is fine; please try again in a few minutes.";

/**
 * A `fetch` that aborts Supabase **auth** calls after `ms`.
 *
 * Deliberately scoped by URL: the same client instance also carries REST and
 * Storage traffic (file uploads, backup mirroring) where a short deadline
 * would break legitimately slow transfers. Only `/auth/v1/*` is timed.
 */
export function authTimeoutFetch(ms: number = AUTH_TIMEOUT_MS): typeof fetch {
  return (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;

    if (!url.includes("/auth/v1/")) return fetch(input, init);

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`Supabase Auth did not respond within ${ms}ms`)),
      ms,
    );

    // Honour a caller-supplied signal too (AbortSignal.any isn't available on
    // every runtime this ships to, so wire it by hand).
    const upstream = init?.signal;
    if (upstream) {
      if (upstream.aborted) controller.abort(upstream.reason);
      else
        upstream.addEventListener("abort", () => controller.abort(upstream.reason), {
          once: true,
        });
    }

    return fetch(input, { ...init, signal: controller.signal }).finally(() =>
      clearTimeout(timer),
    );
  };
}

export type AuthCallResult<T> =
  | { status: "ok"; value: T }
  | { status: "timeout" }
  | { status: "error"; error: unknown };

/**
 * Run an auth call under a hard deadline. Never rejects — the caller gets a
 * verdict, so "the auth service is wedged" is handled like any other outcome
 * instead of bubbling up as an unhandled error or an open request.
 */
export async function withAuthDeadline<T>(
  work: Promise<T>,
  ms: number = AUTH_DEADLINE_MS,
): Promise<AuthCallResult<T>> {
  // Settle the work promise first so a late rejection (the abandoned retry
  // loop finally giving up) can't surface as an unhandled rejection.
  const guarded: Promise<AuthCallResult<T>> = work.then(
    (value) => ({ status: "ok" as const, value }),
    (error) => ({ status: "error" as const, error }),
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<AuthCallResult<T>>((resolve) => {
    timer = setTimeout(() => resolve({ status: "timeout" }), ms);
  });

  try {
    return await Promise.race([guarded, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * True when an auth error means "the auth service is unreachable" rather than
 * "this user has no session" or "that password is wrong".
 *
 * supabase-js turns network failures into AuthRetryableFetchError with no HTTP
 * status; our abort surfaces as an AbortError. A real credential rejection
 * always carries a 4xx.
 */
export function isAuthUnavailable(error: unknown): boolean {
  if (!error) return false;
  const e = error as { name?: string; status?: number; message?: string };
  if (e.name === "AuthRetryableFetchError" || e.name === "AbortError" || e.name === "TimeoutError") {
    return true;
  }
  if (typeof e.status === "number" && (e.status === 0 || e.status >= 500)) return true;
  if (typeof e.status !== "number" && /fetch failed|network|timeout|did not respond|aborted/i.test(e.message ?? "")) {
    return true;
  }
  return false;
}
