// Selling-agent login provisioning. Mirrors how the portal onboards users:
// the agent never receives a password — on approval we create their Supabase
// auth user, mint a one-time set-password link, and email it via the portal's
// SMTP. The agent sets their own password at /agent/set-password.

import type { SupabaseClient, User } from "@supabase/supabase-js";
import { headers } from "next/headers";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { sendMail, agentInviteEmail } from "@/lib/mail";

export interface AgentInviteResult {
  ok: boolean;
  userId?: string;
  isNewUser?: boolean;
  emailSent?: boolean;
  error?: string;
}

/** Absolute base URL of this deployment, from the incoming request host. */
export async function requestBaseUrl(): Promise<string> {
  const h = await headers();
  const host = h.get("host") ?? "x.ekushwml.com";
  const proto = host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https";
  return `${proto}://${host}`;
}

/** Find an existing Supabase auth user by email (null if none). */
export async function findAuthUserByEmail(
  admin: SupabaseClient,
  email: string,
): Promise<User | null> {
  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) return null;
  const lower = email.toLowerCase();
  return data.users.find((u) => u.email?.toLowerCase() === lower) ?? null;
}

/**
 * Ensure the agent has a Supabase auth user, mint a set-password link pointing
 * at /agent/set-password, and email it. Uses an invite link for a brand-new
 * user, or a recovery link if the email already exists (returns the user object
 * either way, so no extra lookup is needed). Does NOT touch xsystem tables —
 * the caller wires Profile + sellingAgent.userId in its audited transaction.
 */
export async function mintAndSendAgentInvite(
  agent: { email: string; fullName: string; code: string },
  baseUrl: string,
): Promise<AgentInviteResult> {
  const admin = createSupabaseAdminClient();
  if (!admin) return { ok: false, error: "SUPABASE_SERVICE_ROLE_KEY is not configured on this deployment." };

  const redirectTo = `${baseUrl.replace(/\/$/, "")}/agent/set-password`;

  let userId: string;
  let actionLink: string;
  let isNewUser: boolean;

  const invite = await admin.auth.admin.generateLink({
    type: "invite",
    email: agent.email,
    options: { redirectTo },
  });

  if (!invite.error && invite.data?.user && invite.data.properties) {
    userId = invite.data.user.id;
    actionLink = invite.data.properties.action_link;
    isNewUser = true;
  } else {
    const recovery = await admin.auth.admin.generateLink({
      type: "recovery",
      email: agent.email,
      options: { redirectTo },
    });
    if (recovery.error || !recovery.data?.user || !recovery.data.properties) {
      return { ok: false, error: recovery.error?.message ?? invite.error?.message ?? "Could not create link" };
    }
    userId = recovery.data.user.id;
    actionLink = recovery.data.properties.action_link;
    isNewUser = false;
  }

  const mail = agentInviteEmail({
    fullName: agent.fullName,
    code: agent.code,
    actionUrl: actionLink,
    isReset: !isNewUser,
  });
  const sent = await sendMail({ to: agent.email, subject: mail.subject, html: mail.html, text: mail.text });

  return {
    ok: true,
    userId,
    isNewUser,
    emailSent: sent.ok,
    error: sent.ok ? undefined : ("error" in sent ? sent.error : undefined),
  };
}
