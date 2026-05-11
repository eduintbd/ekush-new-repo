"use server";

import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";
import { getMfaStatus, hasVerifiedFactor, isStepped } from "@/lib/mfa";
import type { UserRole } from "@/generated/prisma";

const STAFF_ROLES: ReadonlyArray<UserRole> = ["admin", "accountant", "auditor"];

function back(path: "/login" | "/agent/login", error: string, next?: string): never {
  const params = new URLSearchParams({ error });
  if (next) params.set("next", next);
  redirect(`${path}?${params.toString()}`);
}

/**
 * Staff sign-in. Verifies the Profile row exists, is active, and has a
 * staff role. Mirrors the role into Supabase user_metadata so the edge
 * middleware can route by role without hitting Prisma.
 */
export async function signInStaff(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "/dashboard");

  if (!email || !password) {
    back("/login", "Email and password are required.", next);
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.user) {
    back("/login", "Invalid email or password.", next);
  }

  const profile = await prisma.profile.findUnique({ where: { id: data!.user.id } });
  if (!profile || !profile.isActive || !STAFF_ROLES.includes(profile.role)) {
    await supabase.auth.signOut();
    back(
      "/login",
      profile?.role === "selling_agent"
        ? "This account is a selling-agent account. Please use the agent portal."
        : "This account is not authorised for the staff portal.",
      next,
    );
  }

  // Mirror role to user_metadata so the edge middleware can route without
  // a DB lookup. Cheap on every login; profile.role is the source of truth.
  await supabase.auth.updateUser({ data: { role: profile.role } });

  // If the user has a verified MFA factor and the new session is still
  // AAL1, route them through the challenge before the destination.
  const status = await getMfaStatus(supabase);
  if (hasVerifiedFactor(status) && !isStepped(status)) {
    redirect(`/login/mfa?next=${encodeURIComponent(next)}`);
  }

  redirect(next);
}

export async function signOut(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect("/");
}
