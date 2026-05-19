// /admin/cost-centres — Cost-centre master with optional hierarchy.
// Tag a journal line with a cost-centre code to enable per-cost-centre
// reporting (per-fund P&L, per-department expense breakdown, etc.).

import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { formatBdt } from "@/lib/format";
import { createCostCentre, deleteCostCentre, updateCostCentre } from "./actions";

type Search = { ok?: string; error?: string; edit?: string };

export const metadata = { title: "Cost centres — Admin" };

export default async function CostCentresPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  await requireRole(["admin"]);
  const sp = await searchParams;

  const fy = await prisma.fiscalYear
    .findFirst({ where: { isClosed: false }, orderBy: { startsOn: "desc" } })
    .catch(() => null);

  const centres = await prisma.costCentre
    .findMany({ orderBy: [{ code: "asc" }] })
    .catch(() => []);

  // Per-centre journal totals for current FY
  const totalsMap = new Map<string, { debit: number; credit: number; lineCount: number }>();
  if (fy && centres.length > 0) {
    const codes = centres.map((c) => c.code);
    const aggs = await prisma.journal.groupBy({
      by: ["costCentreCode"],
      where: { fiscalYearId: fy.id, costCentreCode: { in: codes } },
      _sum: { debit: true, credit: true },
      _count: { _all: true },
    });
    for (const a of aggs) {
      if (!a.costCentreCode) continue;
      totalsMap.set(a.costCentreCode, {
        debit: Number(a._sum.debit ?? 0),
        credit: Number(a._sum.credit ?? 0),
        lineCount: a._count._all,
      });
    }
  }

  const editing = sp.edit ? centres.find((c) => c.id === sp.edit) : null;

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10 dark:bg-zinc-950">
      <div className="mx-auto max-w-5xl">
        <div className="text-xs uppercase tracking-widest text-zinc-500">
          <Link href="/dashboard" className="hover:text-zinc-700 dark:hover:text-zinc-300">← Dashboard</Link>
          <span className="mx-1.5 text-zinc-400">/</span>
          <span className="normal-case text-zinc-700 dark:text-zinc-300">Cost centres</span>
        </div>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Cost centres
        </h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          {centres.length} cost centre{centres.length === 1 ? "" : "s"}. Activity totals are for{" "}
          {fy?.label ?? "—"}.
        </p>

        {sp.ok && <Banner kind="success">{sp.ok}</Banner>}
        {sp.error && <Banner kind="error">{sp.error}</Banner>}

        {centres.length === 0 ? (
          <p className="mt-6 text-sm text-zinc-500">No cost centres yet — add one below.</p>
        ) : (
          <div className="mt-6 overflow-x-auto rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
              <thead className="bg-zinc-50 dark:bg-zinc-950">
                <tr>
                  <Th>Code</Th>
                  <Th>Name</Th>
                  <Th>Parent</Th>
                  <Th align="right">Lines</Th>
                  <Th align="right">Debit</Th>
                  <Th align="right">Credit</Th>
                  <Th align="right">Net</Th>
                  <Th>Status</Th>
                  <Th />
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {centres.map((c) => {
                  const t = totalsMap.get(c.code);
                  const net = (t?.debit ?? 0) - (t?.credit ?? 0);
                  const parent = centres.find((p) => p.id === c.parentId);
                  return (
                    <tr key={c.id} className={!c.isActive ? "opacity-60" : ""}>
                      <Td className="font-mono text-xs font-medium">{c.code}</Td>
                      <Td>{c.name}</Td>
                      <Td className="text-xs text-zinc-500">{parent?.code ?? "—"}</Td>
                      <Td align="right" className="font-mono text-xs">{t?.lineCount ?? 0}</Td>
                      <Td align="right" className="font-mono text-xs">{t?.debit ? formatBdt(t.debit) : "—"}</Td>
                      <Td align="right" className="font-mono text-xs">{t?.credit ? formatBdt(t.credit) : "—"}</Td>
                      <Td align="right" className="font-mono text-xs font-medium">
                        {Math.abs(net) < 0.005 ? "—" : `${formatBdt(Math.abs(net))} ${net > 0 ? "Dr" : "Cr"}`}
                      </Td>
                      <Td>
                        {c.isActive ? (
                          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium uppercase text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">active</span>
                        ) : (
                          <span className="rounded-full bg-zinc-200 px-2 py-0.5 text-[10px] font-medium uppercase text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">inactive</span>
                        )}
                      </Td>
                      <Td>
                        <div className="flex items-center gap-2 text-[10px]">
                          <Link href={`/admin/cost-centres?edit=${c.id}`} className="underline">edit</Link>
                          <form
                            action={deleteCostCentre}
                            className="inline"
                            data-confirm={`Delete cost centre "${c.code}"?`}
                          >
                            <input type="hidden" name="id" value={c.id} />
                            <button type="submit" className="text-red-600 hover:underline dark:text-red-400">delete</button>
                          </form>
                        </div>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <section className="mt-8 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">
              {editing ? `Edit ${editing.code}` : "Add cost centre"}
            </h2>
            {editing && <Link href="/admin/cost-centres" className="text-xs text-zinc-500 underline">Cancel edit</Link>}
          </div>
          <form action={editing ? updateCostCentre : createCostCentre} className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {editing && <input type="hidden" name="id" value={editing.id} />}
            <label className="block text-xs">
              <span className="font-medium text-zinc-600 dark:text-zinc-400">Code *</span>
              <input
                name="code"
                required
                defaultValue={editing?.code}
                placeholder="e.g. EFUF, ADMIN"
                className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 font-mono dark:border-zinc-700 dark:bg-zinc-950"
              />
            </label>
            <label className="col-span-2 block text-xs">
              <span className="font-medium text-zinc-600 dark:text-zinc-400">Name *</span>
              <input
                name="name"
                required
                defaultValue={editing?.name}
                className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-950"
              />
            </label>
            <label className="block text-xs">
              <span className="font-medium text-zinc-600 dark:text-zinc-400">Parent</span>
              <select
                name="parentId"
                defaultValue={editing?.parentId ?? ""}
                className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-950"
              >
                <option value="">— none —</option>
                {centres.filter((c) => c.id !== editing?.id).map((c) => (
                  <option key={c.id} value={c.id}>{c.code} · {c.name}</option>
                ))}
              </select>
            </label>
            <label className="col-span-2 block text-xs sm:col-span-3">
              <span className="font-medium text-zinc-600 dark:text-zinc-400">Description</span>
              <input
                name="description"
                defaultValue={editing?.description ?? ""}
                className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-950"
              />
            </label>
            {editing && (
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" name="isActive" defaultChecked={editing.isActive} className="rounded border-zinc-400" />
                <span>Active</span>
              </label>
            )}
            <button
              type="submit"
              className="self-end rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
            >
              {editing ? "Save changes" : "+ Add cost centre"}
            </button>
          </form>
        </section>
      </div>
    </main>
  );
}

function Banner({ kind, children }: { kind: "success" | "error"; children: React.ReactNode }) {
  const cls = kind === "success"
    ? "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
    : "border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-300";
  return <div className={`mt-4 rounded-md border px-3 py-2 text-sm ${cls}`}>{children}</div>;
}

function Th({ children, align = "left" }: { children?: React.ReactNode; align?: "left" | "right" }) {
  const a = align === "right" ? "text-right" : "text-left";
  return <th className={`${a} px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500`}>{children}</th>;
}

function Td({ children, align = "left", className = "" }: { children?: React.ReactNode; align?: "left" | "right"; className?: string }) {
  const a = align === "right" ? "text-right tabular-nums" : "text-left";
  return <td className={`${a} px-4 py-2 ${className}`}>{children}</td>;
}
