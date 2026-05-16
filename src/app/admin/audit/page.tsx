// /admin/audit — audit log viewer. The xsystem.audit_log table is fed by
// triggers on journals, agent_terms, commission_runs, fiscal_years (see
// prisma/migrations-manual/02_audit_log_triggers.sql). Filter by actor,
// action, target table/id, and date range.

import Link from "next/link";
import type { Prisma } from "@/generated/prisma";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

type Search = {
  actor?: string;
  action?: string;
  table?: string;
  target?: string;
  from?: string;
  to?: string;
  page?: string;
};

const PAGE_SIZE = 50;

export const metadata = { title: "Audit log — Admin" };

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  await requireRole(["admin", "auditor"]);
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page ?? "1") || 1);

  const where: Prisma.AuditLogWhereInput = {
    ...(sp.action ? { action: { contains: sp.action, mode: "insensitive" } } : {}),
    ...(sp.table ? { targetTable: { contains: sp.table, mode: "insensitive" } } : {}),
    ...(sp.actor ? { actor: sp.actor } : {}),
    ...(sp.target ? { targetId: sp.target } : {}),
    ...(sp.from || sp.to
      ? {
          at: {
            ...(sp.from ? { gte: new Date(sp.from) } : {}),
            ...(sp.to ? { lte: new Date(`${sp.to}T23:59:59Z`) } : {}),
          },
        }
      : {}),
  };

  const [total, rows, actorRows, tableRows, actionRows] = await Promise.all([
    prisma.auditLog.count({ where }).catch(() => 0),
    prisma.auditLog
      .findMany({
        where,
        orderBy: { at: "desc" },
        take: PAGE_SIZE,
        skip: (page - 1) * PAGE_SIZE,
      })
      .catch(() => []),
    prisma.auditLog
      .groupBy({
        by: ["actor"],
        _count: { _all: true },
        orderBy: { _count: { actor: "desc" } },
        take: 10,
      })
      .catch(() => []),
    prisma.auditLog
      .groupBy({
        by: ["targetTable"],
        _count: { _all: true },
        orderBy: { _count: { targetTable: "desc" } },
        take: 10,
      })
      .catch(() => []),
    prisma.auditLog
      .groupBy({
        by: ["action"],
        _count: { _all: true },
        orderBy: { _count: { action: "desc" } },
        take: 10,
      })
      .catch(() => []),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Lookup actor → profile email
  const actorIds = Array.from(new Set(rows.map((r) => r.actor).filter((a): a is string => !!a)));
  const profiles = actorIds.length
    ? await prisma.profile
        .findMany({ where: { id: { in: actorIds } }, select: { id: true, email: true, fullName: true } })
        .catch(() => [])
    : [];
  const profileMap = new Map(profiles.map((p) => [p.id, p]));

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10 dark:bg-zinc-950">
      <div className="mx-auto max-w-7xl">
        <Link
          href="/dashboard"
          className="text-xs uppercase tracking-widest text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
        >
          ← Dashboard
        </Link>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Audit log
        </h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Trigger-fed mutations on journals, agent_terms, commission_runs, fiscal_years.{" "}
          <strong>{total.toLocaleString()}</strong> event{total === 1 ? "" : "s"} match this filter.
        </p>

        {/* Quick-filter chips */}
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <ChipBox title="By action" rows={actionRows.map((a) => ({ label: a.action, count: a._count._all, qs: `action=${encodeURIComponent(a.action)}` }))} />
          <ChipBox title="By target table" rows={tableRows.filter((t) => t.targetTable).map((t) => ({ label: t.targetTable ?? "—", count: t._count._all, qs: `table=${encodeURIComponent(t.targetTable ?? "")}` }))} />
          <ChipBox title="By actor" rows={actorRows.filter((a) => a.actor).map((a) => ({ label: profileMap.get(a.actor ?? "")?.email ?? `${(a.actor ?? "").slice(0, 8)}…`, count: a._count._all, qs: `actor=${encodeURIComponent(a.actor ?? "")}` }))} />
        </div>

        <form className="mt-6 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4 lg:grid-cols-7">
          <label className="block">
            <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">Action</span>
            <input
              name="action"
              placeholder="e.g. journals.create"
              defaultValue={sp.action}
              className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
          <label className="block">
            <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">Table</span>
            <input
              name="table"
              placeholder="e.g. journals"
              defaultValue={sp.table}
              className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
          <label className="block">
            <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">Actor UUID</span>
            <input
              name="actor"
              placeholder="paste user id"
              defaultValue={sp.actor}
              className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 font-mono text-[10px] dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
          <label className="block">
            <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">Target ID</span>
            <input
              name="target"
              placeholder="paste row id"
              defaultValue={sp.target}
              className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 font-mono text-[10px] dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
          <label className="block">
            <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">From</span>
            <input type="date" name="from" defaultValue={sp.from} className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs dark:border-zinc-700 dark:bg-zinc-900" />
          </label>
          <label className="block">
            <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">To</span>
            <input type="date" name="to" defaultValue={sp.to} className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs dark:border-zinc-700 dark:bg-zinc-900" />
          </label>
          <div className="col-span-2 mt-2 flex items-end gap-2 sm:col-span-4 lg:col-span-1">
            <button className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">
              Apply
            </button>
            <Link href="/admin/audit" className="text-xs text-zinc-500 underline">
              Clear
            </Link>
          </div>
        </form>

        {rows.length === 0 ? (
          <p className="mt-10 text-sm text-zinc-500">No audit entries match this filter.</p>
        ) : (
          <div className="mt-6 overflow-x-auto rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <table className="min-w-full divide-y divide-zinc-200 text-xs dark:divide-zinc-800">
              <thead className="bg-zinc-50 dark:bg-zinc-950">
                <tr>
                  <Th>When</Th>
                  <Th>Actor</Th>
                  <Th>Action</Th>
                  <Th>Target</Th>
                  <Th>Target ID</Th>
                  <Th>Before → After</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {rows.map((r) => {
                  const profile = r.actor ? profileMap.get(r.actor) : null;
                  return (
                    <tr key={r.id.toString()}>
                      <Td className="whitespace-nowrap font-mono text-[10px]">
                        {r.at.toISOString().replace("T", " ").slice(0, 19)}
                      </Td>
                      <Td className="whitespace-nowrap">
                        {profile ? (
                          <span title={r.actor ?? undefined}>{profile.fullName ?? profile.email}</span>
                        ) : r.actor ? (
                          <span className="font-mono text-[10px] text-zinc-500" title={r.actor}>
                            {r.actor.slice(0, 8)}…
                          </span>
                        ) : (
                          <span className="text-zinc-400">system</span>
                        )}
                      </Td>
                      <Td>
                        <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] dark:bg-zinc-800">
                          {r.action}
                        </span>
                      </Td>
                      <Td className="text-zinc-600 dark:text-zinc-400">{r.targetTable ?? "—"}</Td>
                      <Td className="font-mono text-[10px] text-zinc-500">
                        {r.targetId ? `${r.targetId.slice(0, 8)}…` : "—"}
                      </Td>
                      <Td className="max-w-md text-[10px]">
                        <JsonDiff before={r.before} after={r.after} />
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {totalPages > 1 && <Pagination page={page} totalPages={totalPages} searchParams={sp} />}
      </div>
    </main>
  );
}

function ChipBox({ title, rows }: { title: string; rows: Array<{ label: string; count: number; qs: string }> }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">{title}</p>
      <ul className="mt-2 space-y-1">
        {rows.length === 0 ? (
          <li className="text-xs text-zinc-400">—</li>
        ) : (
          rows.map((r) => (
            <li key={r.qs} className="flex items-center justify-between text-xs">
              <Link href={`/admin/audit?${r.qs}`} className="truncate hover:underline">
                {r.label}
              </Link>
              <span className="ml-2 font-mono text-[10px] text-zinc-500">{r.count}</span>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}

function JsonDiff({ before, after }: { before: unknown; after: unknown }) {
  if (!before && !after) return <span className="text-zinc-400">—</span>;
  return (
    <details className="cursor-pointer">
      <summary className="text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
        {before && after ? "update" : after ? "create" : "delete"}
      </summary>
      <pre className="mt-1 max-h-40 overflow-auto rounded bg-zinc-50 p-2 text-[9px] leading-tight dark:bg-zinc-950">
        {JSON.stringify({ before, after }, null, 2)}
      </pre>
    </details>
  );
}

function Pagination({ page, totalPages, searchParams }: { page: number; totalPages: number; searchParams: Search }) {
  const buildHref = (p: number) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(searchParams)) {
      if (v && k !== "page") params.set(k, v);
    }
    params.set("page", String(p));
    return `/admin/audit?${params.toString()}`;
  };
  return (
    <div className="mt-4 flex items-center justify-center gap-2 text-sm">
      <PageLink href={buildHref(Math.max(1, page - 1))} disabled={page === 1}>‹ Prev</PageLink>
      <span className="px-3 py-1 text-xs text-zinc-500">Page {page} of {totalPages}</span>
      <PageLink href={buildHref(Math.min(totalPages, page + 1))} disabled={page === totalPages}>Next ›</PageLink>
    </div>
  );
}

function PageLink({ href, disabled, children }: { href: string; disabled: boolean; children: React.ReactNode }) {
  const cls = "rounded-md border border-zinc-300 px-2.5 py-1 text-xs font-medium dark:border-zinc-700";
  if (disabled) return <span className={`${cls} cursor-not-allowed opacity-40`}>{children}</span>;
  return (
    <Link href={href} className={`${cls} hover:bg-zinc-100 dark:hover:bg-zinc-800`}>
      {children}
    </Link>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
      {children}
    </th>
  );
}

function Td({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-4 py-2 ${className}`}>{children}</td>;
}
