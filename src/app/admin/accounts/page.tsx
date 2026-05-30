// /admin/accounts — chart of accounts management. Admin-only.
//
// 126 accounts come from the seed (extracted from F.S March 2026.xlsx).
// Add new accounts here as the AMC needs them — the name becomes the FK
// target for Journal.accountName, so renames cascade to journals.

import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Chart of accounts — Admin" };

type Search = { ok?: string; error?: string; q?: string; show?: string };

export default async function AdminAccountsPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  await requireRole(["admin", "checker"]);
  const sp = await searchParams;

  const showInactive = sp.show === "all";
  const q = (sp.q ?? "").trim();

  const accounts = await prisma.chartOfAccount
    .findMany({
      where: {
        ...(showInactive ? {} : { isActive: true }),
        ...(q
          ? {
              OR: [
                { name: { contains: q, mode: "insensitive" } },
                { category: { contains: q, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      orderBy: [{ sl: "asc" }],
      include: { _count: { select: { journals: true } } },
    })
    .catch(() => []);

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10 dark:bg-zinc-950">
      <div className="mx-auto max-w-6xl">
        <Link
          href="/dashboard"
          className="text-xs uppercase tracking-widest text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
        >
          ← Dashboard
        </Link>

        <div className="mt-3 flex items-end justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-widest text-zinc-500">Admin</p>
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
              Chart of accounts
            </h1>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              {accounts.length} account{accounts.length === 1 ? "" : "s"}
              {showInactive ? " (incl. inactive)" : " active"}.
            </p>
          </div>
          <Link
            href="/admin/accounts/new"
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900"
          >
            + New account
          </Link>
        </div>

        {sp.ok && <Banner kind="success">{sp.ok}</Banner>}
        {sp.error && <Banner kind="error">{sp.error}</Banner>}

        <form className="mt-6 flex items-center gap-2">
          <input
            type="text"
            name="q"
            defaultValue={q}
            placeholder="Search name or category…"
            className="w-64 rounded-md border border-zinc-300 px-3 py-1.5 text-sm focus:border-zinc-900 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950"
          />
          <label className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
            <input
              type="checkbox"
              name="show"
              value="all"
              defaultChecked={showInactive}
              className="rounded border-zinc-400"
            />
            Include inactive
          </label>
          <button
            type="submit"
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            Apply
          </button>
          {(q || showInactive) && (
            <Link
              href="/admin/accounts"
              className="text-xs text-zinc-500 underline hover:text-zinc-700 dark:hover:text-zinc-300"
            >
              Clear
            </Link>
          )}
        </form>

        {accounts.length === 0 ? (
          <p className="mt-10 text-sm text-zinc-500">
            No accounts {q ? "match this filter" : "yet"}.
          </p>
        ) : (
          <div className="mt-6 overflow-x-auto rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
              <thead className="bg-zinc-50 dark:bg-zinc-950">
                <tr>
                  <Th align="right">Sl</Th>
                  <Th>Name</Th>
                  <Th>Normal</Th>
                  <Th>Category</Th>
                  <Th align="right">Journals</Th>
                  <Th>Status</Th>
                  <Th />
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {accounts.map((a) => (
                  <tr key={a.id} className={!a.isActive ? "opacity-60" : ""}>
                    <Td align="right" className="font-mono text-xs">
                      {a.sl}
                    </Td>
                    <Td className="font-medium">
                      <Link
                        href={`/ledger/${encodeURIComponent(a.name)}`}
                        className="underline-offset-2 hover:underline"
                      >
                        {a.name}
                      </Link>
                    </Td>
                    <Td>
                      <NormalBadge nb={a.normalBalance} />
                    </Td>
                    <Td className="text-xs text-zinc-500">{a.category ?? "—"}</Td>
                    <Td align="right" className="font-mono text-xs">
                      {a._count.journals}
                    </Td>
                    <Td>
                      {a.isActive ? (
                        <span className="text-xs text-emerald-700 dark:text-emerald-300">active</span>
                      ) : (
                        <span className="text-xs text-zinc-500">inactive</span>
                      )}
                    </Td>
                    <Td>
                      <Link
                        href={`/admin/accounts/${a.id}`}
                        className="text-xs underline"
                      >
                        edit →
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

function NormalBadge({ nb }: { nb: string }) {
  const cls =
    nb === "DEBIT"
      ? "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200"
      : "bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-200";
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${cls}`}>
      {nb}
    </span>
  );
}

function Banner({ kind, children }: { kind: "success" | "error"; children: React.ReactNode }) {
  const cls =
    kind === "success"
      ? "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
      : "border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-300";
  return <div className={`mt-4 rounded-md border px-3 py-2 text-sm ${cls}`}>{children}</div>;
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
