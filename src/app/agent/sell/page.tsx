// /agent/sell — a selling agent places a SELL (redemption) for an investor they
// sourced. The sell-side twin of /agent/purchase, following the investor's own
// sell flow in the portal (apps/portal/src/app/(portal)/transactions/sell).
//
// Server component: resolves the agent's scope and loads the investors who hold
// sellable units, with their per-fund positions and BO status, plus any BO
// sells still waiting on a DP-40. The API re-derives and re-checks all of it.

import Link from "next/link";
import { getAgentScope } from "@/lib/agent-scope";
import { listPurchaseInvestors } from "@/lib/agent-purchase";
import { listOpenBoSells, listSellInvestors } from "@/lib/agent-sell";
import { OpenBoSells, SellClient } from "./SellClient";

export const metadata = { title: "Sell — Agent portal" };
export const dynamic = "force-dynamic";

export default async function AgentSellPage() {
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

  const allowed = await listPurchaseInvestors({ agentCode: scope.agentCode, linkedCodes: scope.codes });
  const [investors, openSells] = await Promise.all([
    listSellInvestors({ agentCode: scope.agentCode, linkedCodes: scope.codes }),
    listOpenBoSells(allowed.map((a) => a.investorCode)),
  ]);

  return (
    <Shell agentCode={scope.agentCode}>
      {investors.length === 0 ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-900 dark:bg-amber-950/30">
          <p className="font-medium text-amber-900 dark:text-amber-200">No units available to sell</p>
          <p className="mt-1 text-amber-800 dark:text-amber-300">
            None of your investors currently holds units in any fund.
          </p>
        </div>
      ) : (
        <SellClient investors={investors} agentCode={scope.agentCode} />
      )}
      <OpenSellsSection openSells={openSells} />
    </Shell>
  );
}

function OpenSellsSection({ openSells }: { openSells: Awaited<ReturnType<typeof listOpenBoSells>> }) {
  if (openSells.length === 0) return null;
  return (
    <OpenBoSells
      rows={openSells.map((s) => ({ ...s, createdAt: s.createdAt.toISOString(), markedSoldAt: s.markedSoldAt ? s.markedSoldAt.toISOString() : null }))}
    />
  );
}

function Shell({ children, agentCode }: { children: React.ReactNode; agentCode?: string }) {
  return (
    <main className="min-h-screen bg-emerald-50/30 px-6 py-10 dark:bg-emerald-950/30">
      <div className="mx-auto max-w-5xl space-y-8">
        <div>
          <Link href="/agent" className="text-xs text-zinc-500 hover:underline">
            ← Agent dashboard
          </Link>
          <h1 className="mt-1 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">Sell Fund</h1>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            Place a sell (redemption) order on behalf of one of your investors.
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
