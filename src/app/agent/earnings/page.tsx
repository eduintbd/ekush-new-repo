// /agent/earnings — the agent's own income breakdown, live "as of today".
//
// Renders the SAME <CommissionBreakdown> the admin sees on /admin/agents/[id],
// from the same engine, scoped to the signed-in agent. Read-only: the three
// admin slots (suspend/re-instate, set-watermark, post-to-CommissionRun) are
// simply not passed, and the component itself contains no form or server
// action, so there is nothing here for an agent to submit.
//
// Scoping is structural, not a filter: there is no route parameter. The agent
// id comes from the session via getAgentScope(), and the engine derives
// everything from that agent's own investor links — so there is no input an
// agent could tamper with to see someone else's book. Do not add an
// ?agentId= override here.

import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getAgentScope } from "@/lib/agent-scope";
import { computeAgentCommissionPreview } from "@/lib/agent-commission-preview";
import { CommissionBreakdown } from "@/components/commission-breakdown";

export const dynamic = "force-dynamic";

export default async function AgentEarningsPage() {
  const scope = await getAgentScope();
  if (!scope.agentId) {
    return (
      <main className="min-h-screen bg-emerald-50/30 px-6 py-20 dark:bg-emerald-950/30">
        <p className="mx-auto max-w-xl text-sm text-zinc-600 dark:text-zinc-400">
          Your account is not linked to an agent record yet. Contact the office.
        </p>
      </main>
    );
  }

  const preview = await computeAgentCommissionPreview(prisma, scope.agentId).catch(() => null);

  return (
    <main className="min-h-screen bg-emerald-50/30 px-6 py-10 dark:bg-emerald-950/30">
      <div className="mx-auto max-w-5xl space-y-6">
        <div className="text-xs uppercase tracking-widest text-zinc-500">
          <Link href="/agent" className="hover:text-zinc-700 dark:hover:text-zinc-300">← Dashboard</Link>
        </div>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">My earnings</h1>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              Agent <code className="font-mono">{scope.agentCode}</code>
              {preview ? ` · as of ${preview.asOf.toISOString().slice(0, 10)}` : ""}
            </p>
          </div>
          {preview && preview.buckets.length > 0 && (
            <a
              href="/api/agent/commissions/excel"
              className="rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-800"
            >
              Download Excel workbook
            </a>
          )}
        </div>

        {!preview ? (
          <p className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
            Could not compute earnings right now. Try again shortly.
          </p>
        ) : preview.buckets.length === 0 ? (
          <p className="text-sm text-zinc-500">
            No commissionable activity yet. Once your investors transact, your upfront and
            trail earnings appear here.
          </p>
        ) : (
          <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <CommissionBreakdown preview={preview} audience="agent" />
          </div>
        )}
      </div>
    </main>
  );
}
