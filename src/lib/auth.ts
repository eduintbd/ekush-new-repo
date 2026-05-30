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

export type CurrentProfile = Profile;

/**
 * Returns the signed-in user's Profile, or null if unauthenticated /
 * profile missing / Supabase or DB not configured.
 */
export async function getCurrentProfile(): Promise<CurrentProfile | null> {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    return null;
  }
  let supabase;
  try {
    supabase = await createSupabaseServerClient();
  } catch {
    return null;
  }
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  try {
    return await prisma.profile.findUnique({ where: { id: user.id } });
  } catch {
    return null;
  }
}

const STAFF_ROLES: ReadonlyArray<UserRole> = ["admin", "checker", "accountant", "auditor"];

/**
 * Page guard for routes that only require the user to be signed in
 * (e.g. /account/mfa). No role or MFA enforcement — uses the cheapest
 * possible session check. Redirects to /login if not signed in.
 */
export async function requireAuthenticated(): Promise<CurrentProfile> {
  const p = await getCurrentProfile();
  if (!p || !p.isActive) {
    redirect("/login");
  }
  return p;
}

/**
 * Page guard. Redirects to /login if not signed in as active staff. If
 * the role requires MFA (admin/accountant), additionally enforces:
 *   - if no verified factor → /account/mfa?reason=required
 *   - if has factor but session is AAL1 → /login/mfa?next=<current>
 */
export async function requireStaff(): Promise<CurrentProfile> {
  const p = await getCurrentProfile();
  if (!p || !p.isActive || !STAFF_ROLES.includes(p.role)) {
    redirect("/login");
  }
  if (mfaRequiredForRole(p.role)) {
    await enforceMfa("/login/mfa");
  }
  return p;
}

/** Page guard. Redirects to /agent/login if not signed in as active agent. */
export async function requireAgent(): Promise<CurrentProfile> {
  const p = await getCurrentProfile();
  if (!p || !p.isActive || p.role !== "selling_agent") {
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
  const p = await getCurrentProfile();
  if (!p || !p.isActive || !roles.includes(p.role)) {
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
