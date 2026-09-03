"use server";

import { prisma } from "@/lib/prisma";
import { mintAndSendAgentInvite, requestBaseUrl } from "@/lib/agent-invite";

export type ResetOutcome =
  | { status: "sent" }
  | { status: "no_agent" }
  | { status: "failed"; error: string };

// Agent-initiated password reset. Reuses the SAME reliable path as the admin's
// "Resend invite": generateLink(recovery) + send via the portal SMTP — NOT
// Supabase's built-in resetPasswordForEmail (that would use the project's Auth
// email, which isn't configured for external delivery here).
//
// This is an internal agent tool, so we surface the real outcome (sent /
// no-agent / failed-with-reason) rather than a vague "always OK" — otherwise a
// silent rate-limit or SMTP error looks like success and wastes everyone's time.
export async function requestAgentReset(email: string): Promise<ResetOutcome> {
  const e = email.trim().toLowerCase();
  if (!e) return { status: "no_agent" };

  const agent = await prisma.sellingAgent.findFirst({ where: { email: e } }).catch(() => null);
  if (!agent) return { status: "no_agent" };

  const res = await mintAndSendAgentInvite(
    { id: agent.id, email: agent.email, fullName: agent.fullName, code: agent.code },
    await requestBaseUrl(),
  );
  if (!res.ok) return { status: "failed", error: res.error ?? "Could not create the link." };
  if (!res.emailSent) {
    return { status: "failed", error: res.error ?? "The link was created but the email did not send (possibly a rate limit — wait a minute and retry)." };
  }
  return { status: "sent" };
}
