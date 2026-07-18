// /agent/investors — list of investors I sourced. Live join with the
// Ekush Web feed (or the deterministic mock until the API is wired).

import Link from "next/link";
import { requireAgent } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { fetchInvestorsForAgent } from "@/lib/ekush-web/client";
import { formatBdt } from "@/lib/format";
import type { EkushWebInvestor } from "@/lib/ekush-web/types";

export const metadata = { title: "Investors — Agent portal" };

export default async function AgentInvestorsPage() {
  const profile = await requireAgent();
  const agent = await prisma.sellingAgent.findUnique({
    where: { userId: profile.id },
  }).catch(() => null);

  if (!agent) {
    return <NoAgentRecord />;
  }

  let investors: EkushWebInvestor[] = [];
  let fetchError: string | null = null;
  try {
    investors = await fetchInvestorsForAgent(agent.code);
  } catch (e) {
    fetchError = e instanceof Error ? e.message : "Unknown error";
  }

  return (
    <main className="min-h-screen bg-emerald-50/30 px-6 py-10 dark:bg-emerald-950/30">
      <div className="mx-auto max-w-6xl">
        <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
          Investors I sourced
        </h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Agent code <code className="font-mono">{agent.code}</code> ·{" "}
          {investors.length} investor{investors.length === 1 ? "" : "s"}
        </p>

        {fetchError && (
          <p className="mt-4 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
            Could not reach the Ekush Web API: {fetchError}
          </p>
        )}

        {investors.length === 0 ? (
          <p className="mt-10 text-sm text-zinc-500">
            No investors sourced yet. New subscriptions appear here within 5 minutes.
          </p>
        ) : (
          <div className="mt-6 overflow-x-auto rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
              <thead className="bg-zinc-50 dark:bg-zinc-950">
                <tr>
                  <Th>Investor code</Th>
                  <Th>Name</Th>
                  <Th>Fund</Th>
                  <Th>Sourced on</Th>
                  <Th align="right">Initial units</Th>
                  <Th align="right">Outstanding</Th>
                  <Th align="right">Initial gross (BDT)</Th>
                  <Th align="center">Direct?</Th>
                  <Th />
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {investors.map((inv) => {
                  const initialGross = inv.initial_units * inv.unit_price_at_sourcing;
                  return (
                    <tr key={`${inv.investor_code}-${inv.fund_code}-${inv.sourced_on}`}>
                      <Td className="font-mono">{inv.investor_code}</Td>
                      <Td>{inv.full_name}</Td>
                      <Td>{inv.fund_code}</Td>
                      <Td>{inv.sourced_on}</Td>
                      <Td align="right">{formatBdt(inv.initial_units)}</Td>
                      <Td align="right">{formatBdt(inv.units_outstanding)}</Td>
                      <Td align="right">{formatBdt(initialGross)}</Td>
                      <Td align="center">
                        {inv.is_direct_subscription ? (
                          <span className="rounded-full bg-zinc-200 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                            Direct
                          </span>
                        ) : (
                          "—"
                        )}
                      </Td>
                      <Td align="right">
                        <Link
                          href={`/agent/investors/${encodeURIComponent(inv.investor_code)}`}
                          className="text-xs font-medium text-emerald-700 underline hover:text-emerald-800 dark:text-emerald-400"
                        >
                          View
                        </Link>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}

function NoAgentRecord() {
  return (
    <main className="min-h-screen bg-emerald-50/30 px-6 py-20 dark:bg-emerald-950/30">
      <div className="mx-auto max-w-xl">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">
          Profile not linked to an agent record
        </h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          Your account has the selling-agent role but no SellingAgent row is
          linked to it. Ask an admin to approve your agent record.
        </p>
      </div>
    </main>
  );
}

function Th({
  children,
  align = "left",
}: {
  children?: React.ReactNode;
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
