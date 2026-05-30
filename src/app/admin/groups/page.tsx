// /admin/groups — hierarchical account groups (Tally-style). Tree view
// with per-group balance rollup for the current FY. Each group has a
// `nature` (ASSET / LIABILITY / EQUITY / INCOME / EXPENSE) which drives
// statement placement.

import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { formatBdt } from "@/lib/format";
import { createGroup, deleteGroup } from "./actions";

type Search = { ok?: string; error?: string };

export const metadata = { title: "Account groups — Admin" };

type GroupNode = {
  id: string;
  name: string;
  parentId: string | null;
  nature: string;
  sortOrder: number;
  description: string | null;
  isReserved: boolean;
  accountCount: number;
  netBalance: number; // sum of (debit - credit) across all journals on accounts in this group + descendants
  children: GroupNode[];
};

export default async function GroupsPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  await requireRole(["admin", "checker"]);
  const sp = await searchParams;

  const fy = await prisma.fiscalYear
    .findFirst({ where: { isClosed: false }, orderBy: { startsOn: "desc" } })
    .catch(() => null);

  const groups = await prisma.accountGroup
    .findMany({
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      include: { _count: { select: { accounts: true } } },
    })
    .catch(() => []);

  // For each group: sum of journal activity on its accounts in current FY
  const groupBalances = new Map<string, number>();
  if (fy) {
    const accountsByGroup = await prisma.chartOfAccount.findMany({
      where: { groupId: { not: null } },
      select: { name: true, groupId: true },
    });
    const accountToGroup = new Map(accountsByGroup.map((a) => [a.name, a.groupId!]));
    const accNames = accountsByGroup.map((a) => a.name);
    if (accNames.length > 0) {
      const aggs = await prisma.journal.groupBy({
        by: ["accountName"],
        where: { fiscalYearId: fy.id, accountName: { in: accNames } },
        _sum: { debit: true, credit: true },
      });
      for (const a of aggs) {
        const groupId = accountToGroup.get(a.accountName);
        if (!groupId) continue;
        const net = Number(a._sum.debit ?? 0) - Number(a._sum.credit ?? 0);
        groupBalances.set(groupId, (groupBalances.get(groupId) ?? 0) + net);
      }
    }
  }

  // Build tree
  const nodeMap = new Map<string, GroupNode>();
  for (const g of groups) {
    nodeMap.set(g.id, {
      id: g.id,
      name: g.name,
      parentId: g.parentId,
      nature: g.nature,
      sortOrder: g.sortOrder,
      description: g.description,
      isReserved: g.isReserved,
      accountCount: g._count.accounts,
      netBalance: groupBalances.get(g.id) ?? 0,
      children: [],
    });
  }
  const roots: GroupNode[] = [];
  for (const node of nodeMap.values()) {
    if (node.parentId && nodeMap.has(node.parentId)) {
      nodeMap.get(node.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  // Sort children by sortOrder
  const sortRecursive = (n: GroupNode) => {
    n.children.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    n.children.forEach(sortRecursive);
  };
  roots.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  roots.forEach(sortRecursive);

  // Roll up balances bottom-up so parents include descendant totals
  const rollupBalance = (n: GroupNode): number => {
    let total = n.netBalance;
    for (const c of n.children) total += rollupBalance(c);
    n.netBalance = total;
    return total;
  };
  // We mutate netBalance to include descendants — but also want direct-only.
  // Capture direct first, then roll up; expose both.
  const directBalance = new Map<string, number>();
  for (const node of nodeMap.values()) directBalance.set(node.id, node.netBalance);
  roots.forEach(rollupBalance);

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10 dark:bg-zinc-950">
      <div className="mx-auto max-w-5xl">
        <div className="text-xs uppercase tracking-widest text-zinc-500">
          <Link href="/dashboard" className="hover:text-zinc-700 dark:hover:text-zinc-300">← Dashboard</Link>
          <span className="mx-1.5 text-zinc-400">/</span>
          <span className="normal-case text-zinc-700 dark:text-zinc-300">Account groups</span>
        </div>

        <div className="mt-3 flex items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
              Account groups
            </h1>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              {groups.length} groups · balances rolled up for {fy?.label ?? "—"}
            </p>
          </div>
        </div>

        {sp.ok && <Banner kind="success">{sp.ok}</Banner>}
        {sp.error && <Banner kind="error">{sp.error}</Banner>}

        {/* Tree */}
        <div className="mt-6 overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
            <thead className="bg-zinc-50 dark:bg-zinc-950">
              <tr>
                <th className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Group</th>
                <th className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Nature</th>
                <th className="px-4 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Direct accounts</th>
                <th className="px-4 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Direct balance</th>
                <th className="px-4 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Rollup balance</th>
                <th className="px-4 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wider text-zinc-500"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {roots.flatMap((r) => renderRow(r, 0, directBalance))}
            </tbody>
          </table>
        </div>

        {/* New group form */}
        <section className="mt-8 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">Add group</h2>
          <form action={createGroup} className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <label className="block text-xs">
              <span className="font-medium text-zinc-600 dark:text-zinc-400">Name *</span>
              <input
                name="name"
                required
                className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-950"
              />
            </label>
            <label className="block text-xs">
              <span className="font-medium text-zinc-600 dark:text-zinc-400">Parent</span>
              <select
                name="parentId"
                className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-950"
              >
                <option value="">— none (top level) —</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </select>
            </label>
            <label className="block text-xs">
              <span className="font-medium text-zinc-600 dark:text-zinc-400">Nature *</span>
              <select
                name="nature"
                required
                className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-950"
              >
                <option value="">—</option>
                <option value="ASSET">ASSET</option>
                <option value="LIABILITY">LIABILITY</option>
                <option value="EQUITY">EQUITY</option>
                <option value="INCOME">INCOME</option>
                <option value="EXPENSE">EXPENSE</option>
              </select>
            </label>
            <label className="block text-xs">
              <span className="font-medium text-zinc-600 dark:text-zinc-400">Sort order</span>
              <input
                type="number"
                name="sortOrder"
                defaultValue={0}
                className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-950"
              />
            </label>
            <label className="col-span-2 block text-xs sm:col-span-3">
              <span className="font-medium text-zinc-600 dark:text-zinc-400">Description</span>
              <input
                name="description"
                className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-950"
              />
            </label>
            <button
              type="submit"
              className="self-end rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
            >
              + Add group
            </button>
          </form>
        </section>
      </div>
    </main>
  );
}

function renderRow(node: GroupNode, depth: number, directBalance: Map<string, number>): React.ReactNode[] {
  const direct = directBalance.get(node.id) ?? 0;
  const indent = { paddingLeft: `${depth * 1.25 + 1}rem` };
  const out: React.ReactNode[] = [
    <tr key={node.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-950">
      <td className="px-4 py-1.5" style={indent}>
        <span className="font-medium">{node.name}</span>
        {node.isReserved && (
          <span className="ml-2 rounded bg-zinc-100 px-1.5 py-0.5 text-[9px] font-medium uppercase text-zinc-600 dark:bg-zinc-800">
            seeded
          </span>
        )}
      </td>
      <td className="px-4 py-1.5">
        <NatureBadge nature={node.nature} />
      </td>
      <td className="px-4 py-1.5 text-right font-mono text-xs">{node.accountCount > 0 ? node.accountCount : "—"}</td>
      <td className="px-4 py-1.5 text-right font-mono text-xs tabular-nums text-zinc-500">
        {Math.abs(direct) < 0.005 ? "—" : drCr(direct)}
      </td>
      <td className="px-4 py-1.5 text-right font-mono text-xs tabular-nums font-medium">
        {Math.abs(node.netBalance) < 0.005 ? "—" : drCr(node.netBalance)}
      </td>
      <td className="px-4 py-1.5 text-right">
        {!node.isReserved && (
          <form
            action={deleteGroup}
            className="inline"
            data-confirm={`Delete group "${node.name}"? This is irreversible.`}
          >
            <input type="hidden" name="id" value={node.id} />
            <button
              type="submit"
              className="text-[10px] text-red-600 hover:underline dark:text-red-400"
            >
              delete
            </button>
          </form>
        )}
      </td>
    </tr>,
  ];
  for (const c of node.children) out.push(...renderRow(c, depth + 1, directBalance));
  return out;
}

function drCr(amt: number): string {
  return `${formatBdt(Math.abs(amt))} ${amt > 0 ? "Dr" : "Cr"}`;
}

function NatureBadge({ nature }: { nature: string }) {
  const cls: Record<string, string> = {
    ASSET: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200",
    LIABILITY: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200",
    EQUITY: "bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-200",
    INCOME: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
    EXPENSE: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
  };
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${cls[nature] ?? ""}`}>
      {nature}
    </span>
  );
}

function Banner({ kind, children }: { kind: "success" | "error"; children: React.ReactNode }) {
  const cls = kind === "success"
    ? "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
    : "border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-300";
  return <div className={`mt-4 rounded-md border px-3 py-2 text-sm ${cls}`}>{children}</div>;
}
