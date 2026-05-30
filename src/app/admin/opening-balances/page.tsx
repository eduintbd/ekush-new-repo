// /admin/opening-balances — per-FY editor for AccountOpeningBalance.
// Shows every chart-of-accounts entry with its current opening_debit /
// opening_credit (or blank if none). Inline-editable per row. Use this
// to seed opening balances when starting a new fiscal year — the
// roll-forward action on /admin/fiscal-years populates these from the
// previous year's closing balances.

import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { formatBdt } from "@/lib/format";
import { clearOpeningBalance, upsertOpeningBalance } from "./actions";

type Search = { fy?: string; ok?: string; error?: string; q?: string };

export const metadata = { title: "Opening balances — Admin" };

export default async function OpeningBalancesPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  await requireRole(["admin", "checker"]);
  const sp = await searchParams;

  const fiscalYears = await prisma.fiscalYear
    .findMany({ orderBy: { startsOn: "desc" }, select: { id: true, label: true, isClosed: true } })
    .catch(() => []);
  const fyId = sp.fy ?? fiscalYears[0]?.id ?? null;

  if (!fyId) {
    return (
      <main className="min-h-screen bg-zinc-50 px-6 py-10 dark:bg-zinc-950">
        <div className="mx-auto max-w-6xl">
          <Crumb />
          <p className="mt-10 text-sm text-zinc-500">No fiscal years.</p>
        </div>
      </main>
    );
  }

  const q = (sp.q ?? "").trim();
  const accounts = await prisma.chartOfAccount.findMany({
    where: {
      isActive: true,
      ...(q
        ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { category: { contains: q, mode: "insensitive" } }] }
        : {}),
    },
    orderBy: { sl: "asc" },
    include: { group: { select: { name: true, nature: true } } },
  });
  const obs = await prisma.accountOpeningBalance.findMany({
    where: { fiscalYearId: fyId },
  });
  const obMap = new Map(obs.map((o) => [o.accountName, o]));

  const sumDebit = obs.reduce((s, o) => s + Number(o.openingDebit), 0);
  const sumCredit = obs.reduce((s, o) => s + Number(o.openingCredit), 0);
  const balanced = Math.abs(sumDebit - sumCredit) < 1;

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10 dark:bg-zinc-950">
      <div className="mx-auto max-w-7xl">
        <Crumb />
        <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
              Opening balances
            </h1>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              {obs.length} account{obs.length === 1 ? "" : "s"} have an opening balance · Σ debit{" "}
              {formatBdt(sumDebit)} · Σ credit {formatBdt(sumCredit)}{" "}
              {balanced ? (
                <span className="text-emerald-700 dark:text-emerald-300">✓ balanced</span>
              ) : (
                <span className="text-red-700 dark:text-red-300">✗ off by {formatBdt(sumDebit - sumCredit)}</span>
              )}
            </p>
          </div>
          <form className="flex items-end gap-2 text-sm">
            <label className="block">
              <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">Fiscal year</span>
              <select
                name="fy"
                defaultValue={fyId}
                className="mt-1 block w-44 rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-900"
              >
                {fiscalYears.map((y) => (
                  <option key={y.id} value={y.id}>{y.label}{y.isClosed ? " (closed)" : ""}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">Search</span>
              <input
                name="q"
                defaultValue={q}
                placeholder="account or category"
                className="mt-1 block w-48 rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-900"
              />
            </label>
            <button className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">Apply</button>
          </form>
        </div>

        {sp.ok && <Banner kind="success">Saved · {sp.ok}</Banner>}
        {sp.error && <Banner kind="error">{sp.error}</Banner>}

        <div className="mt-6 overflow-x-auto rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <table className="min-w-full divide-y divide-zinc-200 text-xs dark:divide-zinc-800">
            <thead className="bg-zinc-50 dark:bg-zinc-950">
              <tr>
                <th className="px-3 py-2 text-right text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Sl</th>
                <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Account</th>
                <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Group</th>
                <th className="px-3 py-2 text-right text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Opening Debit</th>
                <th className="px-3 py-2 text-right text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Opening Credit</th>
                <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Note</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {accounts.map((a) => {
                const ob = obMap.get(a.name);
                return (
                  <tr key={a.id} className={ob ? "bg-amber-50/30 dark:bg-amber-950/10" : ""}>
                    <td className="px-3 py-1 text-right font-mono text-[10px]">{a.sl}</td>
                    <td className="px-3 py-1 font-medium">{a.name}</td>
                    <td className="px-3 py-1 text-[10px] text-zinc-500">
                      {a.group?.nature ?? "—"} · {a.group?.name ?? "ungrouped"}
                    </td>
                    <td className="px-3 py-1" colSpan={4}>
                      <form action={upsertOpeningBalance} className="flex items-center justify-end gap-1">
                        <input type="hidden" name="fiscalYearId" value={fyId} />
                        <input type="hidden" name="accountName" value={a.name} />
                        <input
                          type="number"
                          step="0.01"
                          name="openingDebit"
                          defaultValue={ob ? Number(ob.openingDebit).toString() : ""}
                          placeholder="0"
                          className="w-32 rounded border border-zinc-300 bg-white px-2 py-0.5 text-right font-mono text-xs tabular-nums dark:border-zinc-700 dark:bg-zinc-950"
                        />
                        <input
                          type="number"
                          step="0.01"
                          name="openingCredit"
                          defaultValue={ob ? Number(ob.openingCredit).toString() : ""}
                          placeholder="0"
                          className="w-32 rounded border border-zinc-300 bg-white px-2 py-0.5 text-right font-mono text-xs tabular-nums dark:border-zinc-700 dark:bg-zinc-950"
                        />
                        <input
                          type="text"
                          name="note"
                          defaultValue={ob?.note ?? ""}
                          placeholder="note"
                          className="w-44 rounded border border-zinc-300 bg-white px-2 py-0.5 text-xs dark:border-zinc-700 dark:bg-zinc-950"
                        />
                        <button type="submit" className="rounded border border-zinc-300 px-2 py-0.5 text-[10px] font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">
                          save
                        </button>
                      </form>
                    </td>
                    <td className="px-3 py-1 text-right">
                      {ob && (
                        <form
                          action={clearOpeningBalance}
                          className="inline"
                          data-confirm={`Clear opening balance for "${a.name}"?`}
                        >
                          <input type="hidden" name="fiscalYearId" value={fyId} />
                          <input type="hidden" name="accountName" value={a.name} />
                          <button type="submit" className="text-[10px] text-red-600 hover:underline dark:text-red-400">
                            clear
                          </button>
                        </form>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <p className="mt-6 text-[11px] text-zinc-500">
          Opening balances seed the trial balance at the start of a fiscal year. The roll-forward
          action on <Link href="/admin/fiscal-years" className="underline">/admin/fiscal-years</Link>{" "}
          populates these from the previous year's closing balances.
        </p>
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

function Crumb() {
  return (
    <div className="text-xs uppercase tracking-widest text-zinc-500">
      <Link href="/dashboard" className="hover:text-zinc-700 dark:hover:text-zinc-300">← Dashboard</Link>
      <span className="mx-1.5 text-zinc-400">/</span>
      <span className="normal-case text-zinc-700 dark:text-zinc-300">Opening balances</span>
    </div>
  );
}
