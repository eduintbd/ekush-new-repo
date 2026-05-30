"use server";

// Team-management server actions. Admin invites/edits back-office staff
// (admin / accountant / auditor). Selling-agent provisioning lives in
// /admin/agents — keep this page focused on bookkeeping personas.
//
// Flow:
//   1. Try Supabase admin invite-by-email. If the email is already a
//      Supabase user (e.g. they're a portal user too), look them up
//      and skip the invite — just attach the X-System profile.
//   2. Insert the xsystem.profiles row with id = auth.users.id, the
//      chosen role, isActive = true.
//
// All mutations are gated by requireRole(["admin"]) and write through
// to the trigger-based audit log automatically (Profile updates show
// up in /admin/audit).

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient, adminClientAvailable } from "@/lib/supabase/admin";

const ADMIN_PATH = "/admin/team";

const STAFF_ROLES = ["admin", "accountant", "auditor"] as const;
type StaffRole = (typeof STAFF_ROLES)[number];

const InviteBody = z.object({
  email: z.string().email("Valid email required").trim().toLowerCase(),
  fullName: z.string().min(1, "Full name required").max(100).trim(),
  role: z.enum(STAFF_ROLES),
});

function back(qs: string, msg: string): never {
  redirect(`${ADMIN_PATH}?${qs}&error=${encodeURIComponent(msg)}`);
}

function ok(msg: string): never {
  redirect(`${ADMIN_PATH}?ok=${encodeURIComponent(msg)}`);
}

/**
 * Invite a new back-office staff member. If the email already has a
 * Supabase auth row (portal user, prior invite), we attach the X-System
 * profile without re-sending the invite. Otherwise Supabase emails a
 * magic-link invite and the user sets their password on first click.
 */
export async function inviteMember(formData: FormData): Promise<void> {
  await requireRole(["admin"]);

  if (!adminClientAvailable()) {
    back("", "SUPABASE_SERVICE_ROLE_KEY is not configured on this deployment.");
  }

  const parsed = InviteBody.safeParse({
    email: String(formData.get("email") ?? ""),
    fullName: String(formData.get("fullName") ?? ""),
    role: String(formData.get("role") ?? ""),
  });
  if (!parsed.success) {
    back("", parsed.error.issues[0]?.message ?? "Invalid input");
  }
  const data = parsed.data;

  const existing = await prisma.profile.findUnique({ where: { email: data.email } });
  if (existing) {
    back("", `${data.email} is already on the team (role: ${existing.role}).`);
  }

  const admin = createSupabaseAdminClient();
  if (!admin) back("", "Supabase admin client unavailable.");

  // Look up the auth.users row by email first. Supabase doesn't expose
  // a direct getByEmail, but listUsers is fine at this team size.
  const { data: list, error: listErr } = await admin.auth.admin.listUsers({
    page: 1,
    perPage: 200,
  });
  if (listErr) back("", `Supabase listUsers failed: ${listErr.message}`);

  let userId: string | null = null;
  const found = list.users.find((u) => u.email?.toLowerCase() === data.email);
  if (found) {
    userId = found.id;
  } else {
    const { data: invited, error: inviteErr } = await admin.auth.admin.inviteUserByEmail(
      data.email,
      { data: { fullName: data.fullName, role: data.role } },
    );
    if (inviteErr || !invited?.user) {
      back("", `Invite failed: ${inviteErr?.message ?? "unknown error"}`);
    }
    userId = invited.user.id;
  }

  if (!userId) back("", "Could not resolve a Supabase user id for the invite.");

  await prisma.profile.create({
    data: {
      id: userId,
      email: data.email,
      fullName: data.fullName,
      role: data.role,
      isActive: true,
    },
  });

  revalidatePath(ADMIN_PATH);
  ok(
    found
      ? `Added ${data.email} as ${data.role}. (Existing Supabase user — no invite email sent.)`
      : `Invited ${data.email} as ${data.role}. They'll receive a sign-up email.`,
  );
}

const ChangeRoleBody = z.object({
  profileId: z.string().uuid("Invalid profile id"),
  role: z.enum(STAFF_ROLES),
});

export async function changeRole(formData: FormData): Promise<void> {
  await requireRole(["admin"]);

  const parsed = ChangeRoleBody.safeParse({
    profileId: String(formData.get("profileId") ?? ""),
    role: String(formData.get("role") ?? ""),
  });
  if (!parsed.success) back("", parsed.error.issues[0]?.message ?? "Invalid input");
  const { profileId, role } = parsed.data;

  const target = await prisma.profile.findUnique({ where: { id: profileId } });
  if (!target) back("", "Profile not found.");

  if (target.role === role) {
    revalidatePath(ADMIN_PATH);
    ok(`No change — ${target.email} is already ${role}.`);
  }

  // Last-admin safety: refuse to demote the only active admin.
  if (target.role === "admin" && role !== "admin") {
    const otherActiveAdmins = await prisma.profile.count({
      where: { role: "admin", isActive: true, NOT: { id: profileId } },
    });
    if (otherActiveAdmins === 0) {
      back("", "Refused — this is the last active admin. Promote someone else first.");
    }
  }

  await prisma.profile.update({
    where: { id: profileId },
    data: { role: role as StaffRole },
  });

  revalidatePath(ADMIN_PATH);
  ok(`${target.email} role changed to ${role}.`);
}

const ProfileIdBody = z.object({ profileId: z.string().uuid("Invalid profile id") });

export async function deactivateMember(formData: FormData): Promise<void> {
  const me = await requireRole(["admin"]);

  const parsed = ProfileIdBody.safeParse({
    profileId: String(formData.get("profileId") ?? ""),
  });
  if (!parsed.success) back("", parsed.error.issues[0]?.message ?? "Invalid input");
  const { profileId } = parsed.data;

  if (profileId === me.id) {
    back("", "Refused — you can't deactivate your own account.");
  }

  const target = await prisma.profile.findUnique({ where: { id: profileId } });
  if (!target) back("", "Profile not found.");

  if (target.role === "admin") {
    const otherActiveAdmins = await prisma.profile.count({
      where: { role: "admin", isActive: true, NOT: { id: profileId } },
    });
    if (otherActiveAdmins === 0) {
      back("", "Refused — this is the last active admin.");
    }
  }

  await prisma.profile.update({
    where: { id: profileId },
    data: { isActive: false },
  });

  revalidatePath(ADMIN_PATH);
  ok(`${target.email} deactivated.`);
}

export async function reactivateMember(formData: FormData): Promise<void> {
  await requireRole(["admin"]);

  const parsed = ProfileIdBody.safeParse({
    profileId: String(formData.get("profileId") ?? ""),
  });
  if (!parsed.success) back("", parsed.error.issues[0]?.message ?? "Invalid input");
  const { profileId } = parsed.data;

  const target = await prisma.profile.findUnique({ where: { id: profileId } });
  if (!target) back("", "Profile not found.");

  await prisma.profile.update({
    where: { id: profileId },
    data: { isActive: true },
  });

  revalidatePath(ADMIN_PATH);
  ok(`${target.email} reactivated.`);
}

export async function resendInvite(formData: FormData): Promise<void> {
  await requireRole(["admin"]);

  if (!adminClientAvailable()) {
    back("", "SUPABASE_SERVICE_ROLE_KEY is not configured.");
  }

  const parsed = ProfileIdBody.safeParse({
    profileId: String(formData.get("profileId") ?? ""),
  });
  if (!parsed.success) back("", parsed.error.issues[0]?.message ?? "Invalid input");
  const { profileId } = parsed.data;

  const target = await prisma.profile.findUnique({ where: { id: profileId } });
  if (!target) back("", "Profile not found.");

  const admin = createSupabaseAdminClient();
  if (!admin) back("", "Supabase admin client unavailable.");

  const { error } = await admin.auth.admin.inviteUserByEmail(target.email);
  if (error) back("", `Resend failed: ${error.message}`);

  ok(`Invite email re-sent to ${target.email}.`);
}
