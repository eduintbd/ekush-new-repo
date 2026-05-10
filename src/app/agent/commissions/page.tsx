// /agent/commissions — list of commission_runs filtered to this agent.

import { requireAgent } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { formatBdt } from "@/lib/format";

export const metadata = { title: "Commissions — Agent portal" };

export default async function AgentCommissionsPage() {
  const profile = await requireAgent();
  const agent = await prisma.sellingAgent
    .findUnique({ where: { userId: profile.id } })
    .catch(() => null);

  if (!agent) {
    return (
      <main className="min-h-screen bg-emerald-50/30 px-6 py-20 dark:bg-emerald-950/30">
        <div className="mx-auto max-w-xl">
          <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">
            Profile not linked to an agent record
          </h1>
        </div>
      </main>
    );
  }

  const runs = await prisma.commissionRun
    .findMany({
      where: { agentId: agent.id },
      orderBy: [{ periodEnd: "desc" }, { createdAt: "desc" }],
      take: 200,
    })
    .catch(() => []);

  return (
    <main className="min-h-screen bg-emerald-50/30 px-6 py-10 dark:bg-emerald-950/30">
      <div className="mx-auto max-w-6xl">
        <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">Commissions</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Agent code <code className="font-mono">{agent.code}</code> ·{" "}
          {runs.length} run{runs.length === 1 ? "" : "s"}
        </p>

        {runs.length === 0 ? (
          <p className="mt-10 text-sm text-zinc-500">
            No commission runs recorded yet. Upfront accrues on each new
            sourced investor; trail accrues quarterly; clawbacks scan nightly.
          </p>
        ) : (
          <div className="mt-6 overflow-x-auto rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
              <thead className="bg-zinc-50 dark:bg-zinc-950">
                <tr>
                  <Th>Period</Th>
                  <Th>Type</Th>
                  <Th align="right">Base (BDT)</Th>
                  <Th align="right">Rate</Th>
                  <Th align="right">Amount (BDT)</Th>
                  <Th>Status</Th>
                  <Th>Paid on</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {runs.map((r) => (
                  <tr key={r.id}>
                    <Td>
                      {r.periodStart ? `${dateOnly(r.periodStart)} → ` : ""}
                      {r.periodEnd ? dateOnly(r.periodEnd) : "—"}
                    </Td>
                    <Td>
                      <Badge type={r.type as "upfront" | "trail" | "clawback"} />
                    </Td>
                    <Td align="right">{formatBdt(Number(r.baseAmount))}</Td>
                    <Td align="right">{(Number(r.rateApplied) * 100).toFixed(4)}%</Td>
                    <Td align="right" className={Number(r.amount) < 0 ? "text-red-600" : ""}>
                      {formatBdt(Number(r.amount))}
                    </Td>
                    <Td>{r.status}</Td>
                    <Td>{r.paidOn ? dateOnly(r.paidOn) : "—"}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}

function dateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function Badge({ type }: { type: "upfront" | "trail" | "clawback" }) {
  const cls =
    type === "upfront"
      ? "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200"
      : type === "trail"
        ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
        : "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200";
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${cls}`}>
      {type}
    </span>
  );
}

function Th({
  children,
  align = "left",
}: {
  children: React.ReactNode;
  align?: "left" | "center" | "right";
}) {
  const a = align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left";
  return (
    <th className={`${a} px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500`}>
      {children}
    </th>
  );
}

function Td({
  children,
  align = "left",
  className = "",
}: {
  children: React.ReactNode;
  align?: "left" | "center" | "right";
  className?: string;
}) {
  const a = align === "right" ? "text-right tabular-nums" : align === "center" ? "text-center" : "text-left";
  return <td className={`${a} px-4 py-2 ${className}`}>{children}</td>;
}
