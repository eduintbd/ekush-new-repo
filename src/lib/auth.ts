// Server-side auth helpers for App Router pages and server actions.
// Supabase Auth owns identity; the Profile row owns role + activation;
// Supabase MFA owns the AAL elevation for admin/accountant.

import { cache } from "react";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";
import type { Profile, UserRole } from "@/generated/prisma";
import {
  getMfaStatus,
  hasVerifiedFactor,
  isStepped,
  mfaRequiredForRole,
} from "@/lib/mfa";
import { isAuthUnavailable, withAuthDeadline } from "@/lib/supabase/resilience";

export type CurrentProfile = Profile;

/** Where the guards send someone when GoTrue itself is wedged. */
const AUTH_OUTAGE_PATH = "/service-unavailable";

/**
 * Returns the signed-in user's Profile, or null if unauthenticated /
 * profile missing / Supabase or DB not configured.
 */
export async function getCurrentProfile(): Promise<CurrentProfile | null> {
  const outcome = await getProfileOutcome();
  return outcome.status === "ok" ? outcome.profile : null;
}

/**
 * Three-way version of getCurrentProfile(). "Not signed in" and "the auth
 * service is down" are different facts: the first means "go to /login", the
 * second means "come back in a few minutes". Collapsing them bounces a
 * validly signed-in user to a login form that cannot work either.
 */
export type ProfileOutcome =
  | { status: "ok"; profile: CurrentProfile }
  | { status: "anonymous" }
  | { status: "auth_unavailable" };

type ClaimsOutcome =
  | { status: "ok"; claims: { sub: string; aal?: string } }
  | { status: "anonymous" }
  | { status: "auth_unavailable" };

/**
 * The signed-in user's verified JWT claims, once per request.
 *
 * getClaims() checks the token's signature and expiry locally against the
 * project's published ES256 key, so it is not a round trip to Supabase Auth
 * the way getUser() is. 2026-10-06: the portal and this app share one Nano
 * Supabase project, and getUser() on every guard (layout + page + each
 * require*()) was most of the /auth/v1/user traffic that overloaded it. The
 * middleware still calls getUser() on each real navigation, and the role and
 * activation come from the Profile row below, so nothing here relies on
 * possibly-stale token metadata.
 */
const getClaimsOutcome = cache(async function getClaimsOutcome(): Promise<ClaimsOutcome> {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    return { status: "anonymous" };
  }
  let supabase;
  try {
    supabase = await createSupabaseServerClient();
  } catch {
    return { status: "anonymous" };
  }

  const result = await withAuthDeadline(supabase.auth.getClaims());
  if (result.status === "timeout") return { status: "auth_unavailable" };
  if (result.status === "error") {
    if (isAuthUnavailable(result.error)) return { status: "auth_unavailable" };
    throw result.error;
  }

  const { data, error } = result.value;
  if (error && isAuthUnavailable(error)) return { status: "auth_unavailable" };
  if (error || !data?.claims?.sub) return { status: "anonymous" };
  return { status: "ok", claims: { sub: data.claims.sub, aal: data.claims.aal as string | undefined } };
});

/** Cached per request: layout, page and every require*() share one lookup. */
export const getProfileOutcome = cache(async function getProfileOutcome(): Promise<ProfileOutcome> {
  const claims = await getClaimsOutcome();
  if (claims.status !== "ok") return claims;
  const data = { user: { id: claims.claims.sub } };

  // The user IS signed in at this point. A failed profile read is a database
  // problem, not a sign-out: treating it as "anonymous" sent agents with a
  // valid session to the login page during the 2026-09-15 pooler outage,
  // where an agent who had never saved their password was then stuck. Retry
  // once, then send them to the "try again" page instead of the login form.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const profile = await prisma.profile.findUnique({ where: { id: data.user.id } });
      return profile ? { status: "ok", profile } : { status: "anonymous" };
    } catch (err) {
      if (attempt === 1) {
        console.error("[auth] profile read failed for a signed-in user:", err);
        return { status: "auth_unavailable" };
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  return { status: "auth_unavailable" };
});

const STAFF_ROLES: ReadonlyArray<UserRole> = ["admin", "checker", "accountant", "auditor"];

/**
 * Page guard for routes that only require the user to be signed in
 * (e.g. /account/mfa). No role or MFA enforcement — uses the cheapest
 * possible session check. Redirects to /login if not signed in.
 */
export async function requireAuthenticated(): Promise<CurrentProfile> {
  const p = await profileOrBounce("/login");
  if (!p.isActive) {
    redirect("/login");
  }
  return p;
}

/**
 * Shared front half of every guard: resolve the profile, or leave via a
 * redirect. An auth outage goes to the 503 page, not to `signedOutPath` —
 * the user is probably signed in and the login page can't help them.
 */
async function profileOrBounce(signedOutPath: string): Promise<CurrentProfile> {
  const outcome = await getProfileOutcome();
  if (outcome.status === "auth_unavailable") redirect(AUTH_OUTAGE_PATH);
  if (outcome.status === "anonymous") redirect(signedOutPath);
  return outcome.profile;
}

/**
 * Page guard. Redirects to /login if not signed in as active staff. If
 * the role requires MFA (admin/accountant), additionally enforces:
 *   - if no verified factor → /account/mfa?reason=required
 *   - if has factor but session is AAL1 → /login/mfa?next=<current>
 */
export async function requireStaff(): Promise<CurrentProfile> {
  const p = await profileOrBounce("/login");
  if (!p.isActive || !STAFF_ROLES.includes(p.role)) {
    redirect("/login");
  }
  if (mfaRequiredForRole(p.role)) {
    await enforceMfa("/login/mfa");
  }
  return p;
}

/** Page guard. Redirects to /agent/login if not signed in as active agent. */
export async function requireAgent(): Promise<CurrentProfile> {
  const p = await profileOrBounce("/agent/login");
  if (!p.isActive || p.role !== "selling_agent") {
    redirect("/agent/login");
  }
  // MFA is optional for selling agents — if they have a factor, still
  // step them up (so an enrolled agent can't downgrade themselves by
  // skipping the challenge).
  await enforceMfaOptional("/agent/login/mfa");
  return p;
}

/** Page guard. Restrict to a specific subset of roles. */
export async function requireRole(roles: ReadonlyArray<UserRole>): Promise<CurrentProfile> {
  const p = await profileOrBounce("/login");
  if (!p.isActive || !roles.includes(p.role)) {
    redirect("/login");
  }
  if (mfaRequiredForRole(p.role)) {
    await enforceMfa("/login/mfa");
  }
  return p;
}

/** A verified token at aal2 means MFA was completed this session — and
 *  aal2 is impossible without a verified factor — so the factor list (a
 *  getUser() round trip inside listFactors) is only needed below aal2. */
async function isSteppedByToken(): Promise<boolean> {
  const c = await getClaimsOutcome();
  return c.status === "ok" && c.claims.aal === "aal2";
}

async function enforceMfa(challengePath: string): Promise<void> {
  if (await isSteppedByToken()) return;
  const supabase = await createSupabaseServerClient();
  const status = await getMfaStatus(supabase);
  if (!hasVerifiedFactor(status)) {
    redirect("/account/mfa?reason=required");
  }
  if (!isStepped(status)) {
    redirect(challengePath);
  }
}

async function enforceMfaOptional(challengePath: string): Promise<void> {
  if (await isSteppedByToken()) return;
  const supabase = await createSupabaseServerClient();
  const status = await getMfaStatus(supabase);
  if (hasVerifiedFactor(status) && !isStepped(status)) {
    redirect(challengePath);
  }
}

/** True iff the current staff user can perform write operations. */
export function canEdit(profile: CurrentProfile): boolean {
  return (
    profile.role === "admin" ||
    profile.role === "checker" ||
    profile.role === "accountant"
  );
}
