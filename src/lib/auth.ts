// Server-side auth helpers for App Router pages and server actions.
// Supabase Auth owns identity; the Profile row owns role + activation;
// Supabase MFA owns the AAL elevation for admin/accountant.

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

export async function getProfileOutcome(): Promise<ProfileOutcome> {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    return { status: "anonymous" };
  }
  let supabase;
  try {
    supabase = await createSupabaseServerClient();
  } catch {
    return { status: "anonymous" };
  }

  const result = await withAuthDeadline(supabase.auth.getUser());
  if (result.status === "timeout") return { status: "auth_unavailable" };
  if (result.status === "error") {
    if (isAuthUnavailable(result.error)) return { status: "auth_unavailable" };
    throw result.error;
  }

  const { data, error } = result.value;
  if (error && isAuthUnavailable(error)) return { status: "auth_unavailable" };
  if (!data.user) return { status: "anonymous" };

  try {
    const profile = await prisma.profile.findUnique({ where: { id: data.user.id } });
    return profile ? { status: "ok", profile } : { status: "anonymous" };
  } catch {
    return { status: "anonymous" };
  }
}

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

async function enforceMfa(challengePath: string): Promise<void> {
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
