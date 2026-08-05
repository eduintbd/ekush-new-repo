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
import { computeAgentCommissionPreview, parseAsOf } from "@/lib/agent-commission-preview";
import { listAgentPayments } from "@/lib/commission-payout";
import { CommissionBreakdown } from "@/components/commission-breakdown";
import { formatBdt } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function AgentEarningsPage({
  searchParams,
}: {
  searchParams: Promise<{ asOf?: string }>;
}) {
  const scope = await getAgentScope();
  const sp = await searchParams;
  if (!scope.agentId) {
    return (
      <main className="min-h-screen bg-emerald-50/30 px-6 py-20 dark:bg-emerald-950/30">
        <p className="mx-auto max-w-xl text-sm text-zinc-600 dark:text-zinc-400">
          Your account is not linked to an agent record yet. Contact the office.
        </p>
      </main>
    );
  }

  // The agent can pin the same billing cut-off the office billed them at, so
  // their file reconciles to the payment advice. Without this their view was
  // always live-to-this-instant and could never be made to match a paid period.
  const asOfParam = sp.asOf ?? "";
  const asOf = parseAsOf(asOfParam);
  const excelQs = asOfParam ? `?asOf=${encodeURIComponent(asOfParam)}` : "";

  const [preview, payments] = await Promise.all([
    computeAgentCommissionPreview(prisma, scope.agentId, asOf).catch(() => null),
    listAgentPayments(scope.agentId).catch(() => []),
  ]);
  const latest = payments[0];

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
              href={`/api/agent/commissions/excel${excelQs}`}
              className="rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-800"
            >
              Download Excel workbook
            </a>
          )}
        </div>

        <form method="GET" className="flex flex-wrap items-end gap-2">
          <label className="block">
            <span className="block text-[10px] uppercase tracking-wider text-zinc-500">
              Show as at
            </span>
            <input
              type="date"
              name="asOf"
              defaultValue={asOfParam}
              max={new Date().toISOString().slice(0, 10)}
              className="mt-1 rounded-md border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
          <button className="rounded-md border border-zinc-300 px-3 py-1 text-xs font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">
            Recalculate
          </button>
          {asOfParam && (
            <Link href="/agent/earnings" className="text-[11px] text-zinc-500 underline">
              back to today
            </Link>
          )}
          <span className="text-[11px] text-zinc-500">
            {asOfParam
              ? "Everything below is as at the close of that date — later transactions are excluded, and the Excel download matches."
              : "Set the end of a paid period to see exactly the figures the office billed."}
          </span>
        </form>

        {/* What has actually been transferred. An agent could previously see
            what they had earned but never what they had been paid, for which
            period, or how much tax was deducted. */}
        {payments.length > 0 && (
          <div className="rounded-lg border border-emerald-200 bg-white p-4 dark:border-emerald-900 dark:bg-zinc-900">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">
              Payments received ({payments.length})
            </h2>
            {latest && (
              <p className="mt-2 text-sm text-zinc-800 dark:text-zinc-200">
                Commission earned up to <strong>{latest.periodEnd}</strong> was paid on{" "}
                <strong>{latest.paidOn}</strong> — gross {formatBdt(latest.gross)}, tax deducted{" "}
                {formatBdt(latest.withholding)}, <strong>net received {formatBdt(latest.net)}</strong>{" "}
                to {latest.bankAccountName}.
              </p>
            )}
            <div className="mt-3 overflow-x-auto">
              <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
                <thead className="text-left text-[11px] uppercase tracking-wider text-zinc-500">
                  <tr>
                    <th className="py-2 pr-3">Earned up to</th>
                    <th className="py-2 pr-3">Paid on</th>
                    <th className="py-2 pr-3 text-right">Upfront</th>
                    <th className="py-2 pr-3 text-right">Trail</th>
                    <th className="py-2 pr-3 text-right">Gross</th>
                    <th className="py-2 pr-3 text-right">Tax deducted</th>
                    <th className="py-2 pr-3 text-right">Net received</th>
                    <th className="py-2 pr-3">Bank</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {payments.map((p) => (
                    <tr key={p.id}>
                      <td className="py-1.5 pr-3 text-xs">{p.periodEnd}</td>
                      <td className="py-1.5 pr-3 text-xs">{p.paidOn}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{formatBdt(p.upfront)}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{formatBdt(p.trail)}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{formatBdt(p.gross)}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">
                        {formatBdt(p.withholding)}
                      </td>
                      <td className="py-1.5 pr-3 text-right font-semibold tabular-nums">
                        {formatBdt(p.net)}
                      </td>
                      <td className="py-1.5 pr-3 text-xs">{p.bankAccountName}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-[11px] text-zinc-500">
              Anything paid here is no longer counted as payable below. Tax deducted at source is
              remitted to the NBR on your behalf.
            </p>
          </div>
        )}

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
