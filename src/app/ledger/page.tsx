// /ledger — staff-accessible account lookup. Click any account row to open
// its ledger card. Admin-only CoA editing lives at /admin/accounts; this
// page is read-only and reachable by every staff role.

import Link from "next/link";
import type { Prisma } from "@/generated/prisma";
import { requireStaff } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

type Search = { q?: string; show?: string };

export const metadata = { title: "Ledgers — Staff portal" };

export default async function LedgerLookupPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  await requireStaff();
  const sp = await searchParams;
  const showInactive = sp.show === "all";
  const q = (sp.q ?? "").trim();

  const where: Prisma.ChartOfAccountWhereInput = {
    ...(showInactive ? {} : { isActive: true }),
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { category: { contains: q, mode: "insensitive" } },
          ],
        }
      : {}),
  };
  const accounts = await prisma.chartOfAccount
    .findMany({ where, orderBy: { sl: "asc" }, include: { _count: { select: { journals: true } } } })
    .catch(() => []);

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10 dark:bg-zinc-950">
      <div className="mx-auto max-w-5xl">
        <Link
          href="/dashboard"
          className="text-xs uppercase tracking-widest text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
        >
          ← Dashboard
        </Link>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Ledgers
        </h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          {accounts.length} account{accounts.length === 1 ? "" : "s"}. Click any row to open the
          ledger card with running balance.
        </p>

        <form className="mt-6 flex items-center gap-2">
          <input
            type="text"
            name="q"
            defaultValue={q}
            placeholder="Search name or category…"
            className="w-64 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm focus:border-zinc-900 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900"
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
            Search
          </button>
          {(q || showInactive) && (
            <Link href="/ledger" className="text-xs text-zinc-500 underline">
              Clear
            </Link>
          )}
        </form>

        {accounts.length === 0 ? (
          <p className="mt-10 text-sm text-zinc-500">No accounts match this filter.</p>
        ) : (
          <div className="mt-6 overflow-x-auto rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
              <thead className="bg-zinc-50 dark:bg-zinc-950">
                <tr>
                  <th className="px-4 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                    Sl
                  </th>
                  <th className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                    Account
                  </th>
                  <th className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                    Normal
                  </th>
                  <th className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                    Category
                  </th>
                  <th className="px-4 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                    Activity
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {accounts.map((a) => (
                  <tr key={a.id} className={!a.isActive ? "opacity-60" : ""}>
                    <td className="px-4 py-2 text-right font-mono text-xs">{a.sl}</td>
                    <td className="px-4 py-2 font-medium">
                      <Link
                        href={`/ledger/${encodeURIComponent(a.name)}`}
                        className="underline-offset-2 hover:underline"
                      >
                        {a.name}
                      </Link>
                    </td>
                    <td className="px-4 py-2">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${
                          a.normalBalance === "DEBIT"
                            ? "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200"
                            : "bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-200"
                        }`}
                      >
                        {a.normalBalance}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-xs text-zinc-500">{a.category ?? "—"}</td>
                    <td className="px-4 py-2 text-right font-mono text-xs">
                      {a._count.journals === 0 ? "—" : a._count.journals}
                    </td>
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
