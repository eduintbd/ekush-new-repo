// /admin/agents/[id] — agent detail. Approve / suspend / reinstate;
// shows current terms + history, sourced investors, recent commissions.

import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { approveAgent, suspendAgent, reinstateAgent } from "@/app/admin/agents/actions";
import { formatBdt } from "@/lib/format";

export default async function AgentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireRole(["admin"]);
  const { id } = await params;
  const agent = await prisma.sellingAgent
    .findUnique({
      where: { id },
      include: {
        terms: { orderBy: { effectiveFrom: "desc" } },
        investors: { orderBy: { sourcedOn: "desc" }, take: 25 },
        commissionRuns: { orderBy: { createdAt: "desc" }, take: 25 },
      },
    })
    .catch(() => null);

  if (!agent) notFound();

  const approve = approveAgent.bind(null, agent.id);
  const suspend = suspendAgent.bind(null, agent.id);
  const reinstate = reinstateAgent.bind(null, agent.id);

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10 dark:bg-zinc-950">
      <div className="mx-auto max-w-5xl space-y-8">
        <div>
          <Link href="/admin/agents" className="text-xs uppercase tracking-widest text-zinc-500">
            ← Agents
          </Link>
          <div className="mt-2 flex items-center justify-between">
            <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
              {agent.fullName}{" "}
              <code className="ml-2 text-base font-mono text-zinc-500">{agent.code}</code>
            </h1>
            <div className="flex items-center gap-2">
              {agent.status === "pending" && (
                <form action={approve}>
                  <button className="rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-800">
                    Approve
                  </button>
                </form>
              )}
              {agent.status === "approved" && (
                <form action={suspend}>
                  <button className="rounded-md bg-orange-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-orange-700">
                    Suspend
                  </button>
                </form>
              )}
              {agent.status === "suspended" && (
                <form action={reinstate}>
                  <button className="rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-800">
                    Reinstate
                  </button>
                </form>
              )}
            </div>
          </div>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            {agent.email}
            {agent.phone && ` · ${agent.phone}`} · status <strong>{agent.status}</strong>
          </p>
        </div>

        <Section title="Terms history">
          {agent.terms.length === 0 ? (
            <p className="text-sm text-zinc-500">
              No terms set. Approve the agent to seed defaults.
            </p>
          ) : (
            <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
              <thead className="text-left text-[11px] uppercase tracking-wider text-zinc-500">
                <tr>
                  <th className="py-2 pr-4">Category</th>
                  <th className="py-2 pr-4">Upfront</th>
                  <th className="py-2 pr-4">Trail Y1 p.a.</th>
                  <th className="py-2 pr-4">Trail Y2+ p.a.</th>
                  <th className="py-2 pr-4">Clawback</th>
                  <th className="py-2 pr-4">Effective</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {agent.terms.map((t) => (
                  <tr key={t.id}>
                    <td className="py-1.5 pr-4">{t.fundCategory}</td>
                    <td className="py-1.5 pr-4 tabular-nums">{(Number(t.upfrontPct) * 100).toFixed(2)}%</td>
                    <td className="py-1.5 pr-4 tabular-nums">{(Number(t.trailY1PctPa) * 100).toFixed(2)}%</td>
                    <td className="py-1.5 pr-4 tabular-nums">{(Number(t.trailY2PlusPctPa) * 100).toFixed(2)}%</td>
                    <td className="py-1.5 pr-4">
                      {t.clawbackMonths}mo @ {(Number(t.clawbackPct) * 100).toFixed(0)}%
                    </td>
                    <td className="py-1.5 pr-4">
                      {t.effectiveFrom.toISOString().slice(0, 10)} →{" "}
                      {t.effectiveTo ? t.effectiveTo.toISOString().slice(0, 10) : "now"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>

        <Section title={`Recent commissions (${agent.commissionRuns.length})`}>
          {agent.commissionRuns.length === 0 ? (
            <p className="text-sm text-zinc-500">No runs yet.</p>
          ) : (
            <table className="min-w-full text-sm">
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {agent.commissionRuns.map((r) => (
                  <tr key={r.id}>
                    <td className="py-1.5 pr-4 text-xs uppercase">{r.type}</td>
                    <td className="py-1.5 pr-4">
                      {r.periodEnd ? r.periodEnd.toISOString().slice(0, 10) : "—"}
                    </td>
                    <td className="py-1.5 pr-4 text-right tabular-nums">{formatBdt(Number(r.amount))}</td>
                    <td className="py-1.5 pr-4 text-xs">{r.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>

        <Section title={`Sourced investors (${agent.investors.length})`}>
          {agent.investors.length === 0 ? (
            <p className="text-sm text-zinc-500">No agent_investors rows yet.</p>
          ) : (
            <table className="min-w-full text-sm">
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {agent.investors.map((i) => (
                  <tr key={i.id}>
                    <td className="py-1.5 pr-4 font-mono text-xs">{i.investorCode}</td>
                    <td className="py-1.5 pr-4">{i.fundCode}</td>
                    <td className="py-1.5 pr-4">{i.sourcedOn.toISOString().slice(0, 10)}</td>
                    <td className="py-1.5 pr-4 text-right tabular-nums">
                      {formatBdt(Number(i.initialGrossAmount))}
                    </td>
                    {i.isDirectSubscription && (
                      <td className="py-1.5 pr-4 text-xs text-zinc-500">direct</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>
      </div>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-500">{title}</h2>
      <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        {children}
      </div>
    </section>
  );
}
