// Resolves the signed-in selling agent and the set of investor codes under
// them (xsystem.agent_investors). EVERY agent-facing read/write must be gated
// to these codes — an agent may only see/act on investors they sourced.

import { requireAgent } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export interface AgentScope {
  agentId: string;
  agentCode: string;
  fullName: string;
  /** Distinct investor codes linked to this agent (may be empty). */
  codes: string[];
  codeSet: Set<string>;
}

/**
 * Page/route guard: requires an active selling_agent session and returns the
 * agent + their investor-code scope. Redirects to /agent/login otherwise.
 */
export async function getAgentScope(): Promise<AgentScope> {
  const profile = await requireAgent();
  const agent = await prisma.sellingAgent.findUnique({ where: { userId: profile.id } });
  if (!agent) {
    return {
      agentId: "",
      agentCode: "",
      fullName: profile.fullName ?? "",
      codes: [],
      codeSet: new Set(),
    };
  }
  const links = await prisma.agentInvestor.findMany({
    where: { agentId: agent.id },
    select: { investorCode: true },
  });
  const codes = Array.from(new Set(links.map((l) => l.investorCode)));
  return {
    agentId: agent.id,
    agentCode: agent.code,
    fullName: agent.fullName,
    codes,
    codeSet: new Set(codes),
  };
}

/** True iff the given investor code is under the current agent. */
export function agentOwnsCode(scope: AgentScope, code: string): boolean {
  return scope.codeSet.has(code);
}
