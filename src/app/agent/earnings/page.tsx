// /agent/earnings — the agent's own income breakdown, live "as of today".
// Reuses the exact engine the admin sees (computeAgentCommissionPreview),
// scoped to the signed-in agent, rendered read-only (no admin post/suspend).

import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getAgentScope } from "@/lib/agent-scope";
import { computeAgentCommissionPreview } from "@/lib/agent-commission-preview";
import { formatBdt } from "@/lib/format";

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
        <div>
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">My earnings</h1>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            Agent <code className="font-mono">{scope.agentCode}</code>
            {preview ? ` · as of ${preview.asOf.toISOString().slice(0, 10)}` : ""}
          </p>
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
          <>
            {/* Totals */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Total inflow" value={formatBdt(preview.totals.inflow)} muted />
              <Stat label="Upfront pending" value={formatBdt(preview.totals.pendingUpfront)} hint="not yet paid" />
              <Stat label="Trail to date" value={formatBdt(preview.totals.trail)} />
              <Stat label="Total payable" value={formatBdt(preview.totals.totalPayable)} emphasis hint="pending upfront + trail" />
            </div>

            {/* Per-investor breakdown */}
            <section>
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-500">
                By investor
              </h2>
              <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
                <table className="min-w-full text-sm">
                  <thead className="text-left text-[11px] uppercase tracking-wider text-zinc-500">
                    <tr>
                      <th className="px-3 py-2">Investor</th>
                      <th className="px-3 py-2">Name</th>
                      <th className="px-3 py-2">Fund</th>
                      <th className="px-3 py-2">Sourced</th>
                      <th className="px-3 py-2 text-right">Inflow</th>
                      <th className="px-3 py-2 text-right">Upfront</th>
                      <th className="px-3 py-2 text-right">Trail</th>
                      <th className="px-3 py-2 text-right">Payable</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                    {preview.buckets.map((b) => (
                      <tr key={`${b.investorCode}-${b.fundCode}`} className={b.isDirectSubscription ? "text-zinc-400" : ""}>
                        <td className="px-3 py-1.5 font-mono text-xs">{b.investorCode}</td>
                        <td className="px-3 py-1.5">
                          {b.name || "—"}
                          {b.isDirectSubscription && (
                            <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[9px] font-medium uppercase text-amber-800 dark:bg-amber-950 dark:text-amber-200">
                              direct
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-1.5 text-xs">{b.fundCode}</td>
                        <td className="px-3 py-1.5 text-xs">{b.sourcedOn.toISOString().slice(0, 10)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{formatBdt(b.inflowTotal)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{formatBdt(b.perInflowUpfront)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{formatBdt(b.trailTotal)}</td>
                        <td className="px-3 py-1.5 text-right font-semibold tabular-nums">
                          {formatBdt(b.perInflowUpfront + b.trailTotal)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            {/* Trail detail */}
            {preview.trailRows.length > 0 && (
              <details className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
                <summary className="cursor-pointer text-sm font-semibold uppercase tracking-wider text-zinc-500">
                  Trail detail — period by period ({preview.trailRows.length})
                </summary>
                <div className="mt-3 overflow-x-auto">
                  <table className="min-w-full text-xs">
                    <thead className="text-left text-[10px] uppercase tracking-wider text-zinc-500">
                      <tr>
                        <th className="py-1 pr-3">Investor</th>
                        <th className="py-1 pr-3">Fund</th>
                        <th className="py-1 pr-3">Period</th>
                        <th className="py-1 pr-3">Tier</th>
                        <th className="py-1 pr-3 text-right">Rate p.a.</th>
                        <th className="py-1 pr-3 text-right">Avg value</th>
                        <th className="py-1 pr-3 text-right">Trail</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                      {preview.trailRows.map((r, i) => (
                        <tr key={i}>
                          <td className="py-1 pr-3 font-mono">{r.investorCode}</td>
                          <td className="py-1 pr-3">{r.fundCode}</td>
                          <td className="py-1 pr-3 font-mono text-[10px]">{r.qLabel}</td>
                          <td className="py-1 pr-3">{r.tier}</td>
                          <td className="py-1 pr-3 text-right tabular-nums">{(r.ratePa * 100).toFixed(4)}%</td>
                          <td className="py-1 pr-3 text-right tabular-nums">{formatBdt(r.avgValue)}</td>
                          <td className="py-1 pr-3 text-right font-semibold tabular-nums">
                            {formatBdt(r.trail)}
                            {r.partial ? <span className="ml-1 text-amber-600">*</span> : ""}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="mt-2 text-[10px] text-zinc-500">
                    * partial period — still accruing; paid at period close.
                  </p>
                </div>
              </details>
            )}
          </>
        )}
      </div>
    </main>
  );
}

function Stat({
  label,
  value,
  hint,
  emphasis = false,
  muted = false,
}: {
  label: string;
  value: string;
  hint?: string;
  emphasis?: boolean;
  muted?: boolean;
}) {
  return (
    <div
      className={`rounded-md border p-3 ${
        emphasis
          ? "border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950"
          : muted
            ? "border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950"
            : "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"
      }`}
    >
      <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">{label}</p>
      <p className={`mt-0.5 font-mono tabular-nums ${emphasis ? "text-lg font-bold text-emerald-800 dark:text-emerald-200" : "text-base"}`}>
        {value}
      </p>
      {hint && <p className="mt-0.5 text-[10px] text-zinc-500">{hint}</p>}
    </div>
  );
}
