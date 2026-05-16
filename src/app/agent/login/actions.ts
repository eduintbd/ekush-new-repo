"use server";

import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";
import { getMfaStatus, hasVerifiedFactor, isStepped } from "@/lib/mfa";

function back(error: string, next?: string): never {
  const params = new URLSearchParams({ error });
  if (next) params.set("next", next);
  redirect(`/agent/login?${params.toString()}`);
}

/**
 * Selling-agent sign-in. Same auth.users table as staff; we reject if the
 * Profile role is not 'selling_agent'. Status check on selling_agents row
 * happens at /agent/* page level (the agent may be approved-then-suspended).
 */
export async function signInAgent(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "/agent");

  if (!email || !password) {
    back("Email and password are required.", next);
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.user) {
    back("Invalid email or password.", next);
  }

  const profile = await prisma.profile.findUnique({ where: { id: data!.user.id } });
  if (!profile || !profile.isActive || profile.role !== "selling_agent") {
    await supabase.auth.signOut();
    back("This account is not a selling-agent account.", next);
  }

  // Namespaced field — see src/app/login/actions.ts for rationale.
  await supabase.auth.updateUser({ data: { xsystem_role: profile.role } });

  // Agents who chose to enrol MFA still get challenged on sign-in.
  const status = await getMfaStatus(supabase);
  if (hasVerifiedFactor(status) && !isStepped(status)) {
    redirect(`/agent/login/mfa?next=${encodeURIComponent(next)}`);
  }

  redirect(next);
}
