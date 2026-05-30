// /admin/agents — list of selling agents with status + last-action.

import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Agents — Admin" };

export default async function AdminAgentsPage() {
  await requireRole(["admin", "checker"]);

  const agents = await prisma.sellingAgent
    .findMany({
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      include: { _count: { select: { investors: true, commissionRuns: true } } },
    })
    .catch(() => []);

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10 dark:bg-zinc-950">
      <div className="mx-auto max-w-6xl">
        <Link href="/dashboard" className="text-xs uppercase tracking-widest text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
          ← Dashboard
        </Link>
        <div className="mt-3 flex items-end justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-widest text-zinc-500">Admin</p>
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
              Selling agents
            </h1>
          </div>
          <Link
            href="/admin/agents/new"
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900"
          >
            + Invite agent
          </Link>
        </div>

        {agents.length === 0 ? (
          <p className="mt-10 text-sm text-zinc-500">
            No agents yet. Click <em>Invite agent</em> to send the first invitation.
          </p>
        ) : (
          <div className="mt-6 overflow-x-auto rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
              <thead className="bg-zinc-50 dark:bg-zinc-950">
                <tr>
                  <Th>Code</Th>
                  <Th>Name</Th>
                  <Th>Email</Th>
                  <Th>Status</Th>
                  <Th align="right">Sourced</Th>
                  <Th align="right">Runs</Th>
                  <Th>Approved</Th>
                  <Th />
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {agents.map((a) => (
                  <tr key={a.id}>
                    <Td className="font-mono">{a.code}</Td>
                    <Td>{a.fullName}</Td>
                    <Td>{a.email}</Td>
                    <Td>
                      <StatusBadge status={a.status} />
                    </Td>
                    <Td align="right">{a._count.investors}</Td>
                    <Td align="right">{a._count.commissionRuns}</Td>
                    <Td>{a.approvedAt ? a.approvedAt.toISOString().slice(0, 10) : "—"}</Td>
                    <Td>
                      <Link href={`/admin/agents/${a.id}`} className="text-xs underline">
                        manage →
                      </Link>
                    </Td>
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

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    pending: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
    approved: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
    suspended: "bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-200",
    terminated: "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  };
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${
        map[status] ?? map.terminated
      }`}
    >
      {status}
    </span>
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
