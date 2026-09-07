// /agent/purchase — a selling agent places a lump-sum BUY for an investor they
// sourced. The order is written to the portal's tables and appears on
// portal.ekushwml.com/admin/approvals exactly as an investor-raised one does;
// approving it there fires the investor's email and WhatsApp through the
// portal's existing handler.
//
// Server component: resolves the agent's scope and loads the pickable
// investors and funds, then hands them to the client wizard. The investor list
// is wider than /agent/sip's on purpose — see listPurchaseInvestors — because
// the first purchase right after onboarding is the common case. The API
// re-derives the same list and re-checks scope, so tampering with the request
// gains nothing.

import Link from "next/link";
import { getAgentScope } from "@/lib/agent-scope";
import { listPurchaseFunds, listPurchaseInvestors } from "@/lib/agent-purchase";
import { PurchaseClient } from "./PurchaseClient";

export const metadata = { title: "Purchase — Agent portal" };
export const dynamic = "force-dynamic";

export default async function AgentPurchasePage() {
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

  const [investors, funds] = await Promise.all([
    listPurchaseInvestors({ agentCode: scope.agentCode, linkedCodes: scope.codes }),
    listPurchaseFunds(),
  ]);

  if (investors.length === 0) {
    return (
      <Shell agentCode={scope.agentCode}>
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-900 dark:bg-amber-950/30">
          <p className="font-medium text-amber-900 dark:text-amber-200">
            No investors available yet
          </p>
          <p className="mt-1 text-amber-800 dark:text-amber-300">
            A purchase can only be raised for an investor whose account is open — approved KYC, a
            real investor code and an active portal login. Investors you onboard appear here as soon
            as the office approves them.
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
      <PurchaseClient investors={investors} funds={funds} agentCode={scope.agentCode} />
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
          <h1 className="mt-1 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">Buy Fund</h1>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            Place a lump-sum purchase on behalf of one of your investors.
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
