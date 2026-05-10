// Server-side auth helpers for App Router pages and server actions.
// Supabase Auth owns identity; the Profile row owns role + activation.

import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";
import type { Profile, UserRole } from "@/generated/prisma";

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

const STAFF_ROLES: ReadonlyArray<UserRole> = ["admin", "accountant", "auditor"];

/** Page guard. Redirects to /login if not signed in as active staff. */
export async function requireStaff(): Promise<CurrentProfile> {
  const p = await getCurrentProfile();
  if (!p || !p.isActive || !STAFF_ROLES.includes(p.role)) {
    redirect("/login");
  }
  return p;
}

/** Page guard. Redirects to /agent/login if not signed in as active agent. */
export async function requireAgent(): Promise<CurrentProfile> {
  const p = await getCurrentProfile();
  if (!p || !p.isActive || p.role !== "selling_agent") {
    redirect("/agent/login");
  }
  return p;
}

/** Page guard. Restrict to a specific subset of roles. */
export async function requireRole(roles: ReadonlyArray<UserRole>): Promise<CurrentProfile> {
  const p = await getCurrentProfile();
  if (!p || !p.isActive || !roles.includes(p.role)) {
    redirect("/login");
  }
  return p;
}

/** True iff the current staff user can perform write operations. */
export function canEdit(profile: CurrentProfile): boolean {
  return profile.role === "admin" || profile.role === "accountant";
}
