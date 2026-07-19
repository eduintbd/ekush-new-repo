"use server";

import { prisma } from "@/lib/prisma";
import { mintAndSendAgentInvite, requestBaseUrl } from "@/lib/agent-invite";

// Agent-initiated password reset. Reuses the SAME reliable path as the admin's
// "Resend invite": generateLink(recovery) + send via the portal SMTP — NOT
// Supabase's built-in resetPasswordForEmail (that would use the project's Auth
// email, which isn't configured for external delivery here). Always returns ok
// so the form can't be used to probe which emails are agents.
export async function requestAgentReset(email: string): Promise<{ ok: true }> {
  const e = email.trim().toLowerCase();
  if (e) {
    const agent = await prisma.sellingAgent.findFirst({ where: { email: e } }).catch(() => null);
    if (agent) {
      await mintAndSendAgentInvite(
        { email: agent.email, fullName: agent.fullName, code: agent.code },
        await requestBaseUrl(),
      ).catch(() => {});
    }
  }
  return { ok: true };
}
