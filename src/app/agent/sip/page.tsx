// /agent/sip — a selling agent raises a SIP instruction for an investor they
// sourced. The plan is written to the portal's tables and appears on
// portal.ekushwml.com/admin/approvals exactly as an investor-raised one does.
//
// Server component: resolves the agent's scope and loads the pickable
// investors, funds and bank accounts, then hands them to the client form. The
// investor list is the agent's AgentInvestor links — the same list as "My
// investors" — so nothing outside their book can be selected even by tampering
// with the request, and the API re-checks scope anyway.

import Link from "next/link";
import { getAgentScope } from "@/lib/agent-scope";
import { listSipFunds, listSipInvestors } from "@/lib/agent-sip";
import { SipClient } from "./SipClient";

export const metadata = { title: "Start SIP — Agent portal" };
export const dynamic = "force-dynamic";

export default async function AgentSipPage() {
  const scope = await getAgentScope();

  if (!scope.agentId) {
    return (
      <Shell>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Your profile isn&apos;t linked to a selling-agent record yet — contact admin.
        </p>
      </Shell>
    );
  }

  const [investors, funds] = await Promise.all([listSipInvestors(scope.codes), listSipFunds()]);

  if (investors.length === 0) {
    return (
      <Shell agentCode={scope.agentCode}>
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-900 dark:bg-amber-950/30">
          <p className="font-medium text-amber-900 dark:text-amber-200">No investors available yet</p>
          <p className="mt-1 text-amber-800 dark:text-amber-300">
            A SIP can only be raised for an investor whose account is fully open — approved KYC, a
            real investor code, and a first investment recorded. Investors you have onboarded appear
            here once that is done.
          </p>
          <Link href="/agent/investors" className="mt-3 inline-block text-xs font-medium underline">
            See my investors →
          </Link>
        </div>
      </Shell>
    );
  }

  return (
    <Shell agentCode={scope.agentCode}>
      <SipClient investors={investors} funds={funds} agentCode={scope.agentCode} />
    </Shell>
  );
}

function Shell({ children, agentCode }: { children: React.ReactNode; agentCode?: string }) {
  return (
    <main className="min-h-screen bg-emerald-50/30 px-6 py-10 dark:bg-emerald-950/30">
      <div className="mx-auto max-w-5xl">
        <div className="mb-6">
          <Link href="/agent" className="text-xs text-zinc-500 hover:underline">
            ← Agent dashboard
          </Link>
          <h1 className="mt-1 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">Start SIP</h1>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            Create a monthly SIP instruction on behalf of one of your investors.
            {agentCode ? (
              <>
                {" "}
                Agent code <code className="font-mono">{agentCode}</code>.
              </>
            ) : null}
          </p>
        </div>
        {children}
      </div>
    </main>
  );
}
