// /admin/fiscal-years — fiscal year master + lifecycle. Create new FYs,
// close + reopen, and the headline action: roll-forward (compute closing
// balances of FY-N → seed AccountOpeningBalance of FY-(N+1)).

import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { closeFiscalYear, createFiscalYear, reopenFiscalYear, rollForward } from "./actions";

type Search = { ok?: string; error?: string };

export const metadata = { title: "Fiscal years — Admin" };

export default async function FiscalYearsPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  await requireRole(["admin", "checker"]);
  const sp = await searchParams;

  const fys = await prisma.fiscalYear
    .findMany({
      orderBy: { startsOn: "desc" },
      include: {
        _count: { select: { journals: true, openingBalances: true } },
      },
    })
    .catch(() => []);

  // Equity accounts as candidates for "Retained Earnings" target
  const equityAccounts = await prisma.chartOfAccount.findMany({
    where: { group: { nature: "EQUITY" } },
    orderBy: { sl: "asc" },
    select: { name: true },
  });

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10 dark:bg-zinc-950">
      <div className="mx-auto max-w-6xl">
        <div className="text-xs uppercase tracking-widest text-zinc-500">
          <Link href="/dashboard" className="hover:text-zinc-700 dark:hover:text-zinc-300">← Dashboard</Link>
          <span className="mx-1.5 text-zinc-400">/</span>
          <span className="normal-case text-zinc-700 dark:text-zinc-300">Fiscal years</span>
        </div>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Fiscal years
        </h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          {fys.length} fiscal year{fys.length === 1 ? "" : "s"} on file. Closing a year blocks all
          journal mutations against it (DB-level trigger). Roll-forward seeds the next year's
          opening balances.
        </p>

        {sp.ok && <Banner kind="success">{sp.ok}</Banner>}
        {sp.error && <Banner kind="error">{sp.error}</Banner>}

        <div className="mt-6 overflow-x-auto rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
            <thead className="bg-zinc-50 dark:bg-zinc-950">
              <tr>
                <Th>Label</Th>
                <Th>Period</Th>
                <Th align="right">Journals</Th>
                <Th align="right">Opening rows</Th>
                <Th>Status</Th>
                <Th>Closed at</Th>
                <Th />
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {fys.map((y) => (
                <tr key={y.id}>
                  <Td className="font-medium">{y.label}</Td>
                  <Td className="text-xs text-zinc-500">
                    {y.startsOn.toISOString().slice(0, 10)} → {y.endsOn.toISOString().slice(0, 10)}
                  </Td>
                  <Td align="right" className="font-mono text-xs">{y._count.journals}</Td>
                  <Td align="right" className="font-mono text-xs">{y._count.openingBalances}</Td>
                  <Td>
                    {y.isClosed ? (
                      <span className="rounded-full bg-zinc-200 px-2 py-0.5 text-[10px] font-medium uppercase text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                        closed
                      </span>
                    ) : (
                      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium uppercase text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                        open
                      </span>
                    )}
                  </Td>
                  <Td className="text-xs text-zinc-500">
                    {y.closedAt ? y.closedAt.toISOString().slice(0, 10) : "—"}
                  </Td>
                  <Td>
                    {y.isClosed ? (
                      <form
                        action={reopenFiscalYear}
                        className="inline"
                        data-confirm={`Reopen ${y.label}? This unlocks all journals in this fiscal year for editing.`}
                      >
                        <input type="hidden" name="id" value={y.id} />
                        <button type="submit" className="text-[10px] text-amber-700 underline dark:text-amber-300">
                          reopen
                        </button>
                      </form>
                    ) : (
                      <form
                        action={closeFiscalYear}
                        className="inline"
                        data-confirm={`Close ${y.label}? Once closed, no journals can be added or modified in this fiscal year.`}
                      >
                        <input type="hidden" name="id" value={y.id} />
                        <button type="submit" className="text-[10px] text-red-600 underline dark:text-red-400">
                          close
                        </button>
                      </form>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* New FY */}
        <section className="mt-8 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">
            Add fiscal year
          </h2>
          <form action={createFiscalYear} className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <label className="block text-xs">
              <span className="font-medium text-zinc-600 dark:text-zinc-400">Label *</span>
              <input
                name="label"
                required
                placeholder="e.g. FY2026-27"
                className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-950"
              />
            </label>
            <label className="block text-xs">
              <span className="font-medium text-zinc-600 dark:text-zinc-400">Starts on *</span>
              <input
                type="date"
                name="startsOn"
                required
                className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-950"
              />
            </label>
            <label className="block text-xs">
              <span className="font-medium text-zinc-600 dark:text-zinc-400">Ends on *</span>
              <input
                type="date"
                name="endsOn"
                required
                className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-950"
              />
            </label>
            <button
              type="submit"
              className="self-end rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
            >
              + Add fiscal year
            </button>
          </form>
        </section>

        {/* Roll-forward */}
        <section className="mt-8 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">
            Roll forward
          </h2>
          <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
            Computes closing balances of the source FY and seeds opening balances on the target FY.
            BS accounts (Asset / Liability / Equity) carry forward as-is. P&L accounts (Income /
            Expense) collapse into a single Retained Earnings entry — pick which equity account.
            Idempotent — re-running overwrites prior roll-forward results for affected accounts.
          </p>
          <form
            action={rollForward}
            className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4"
            data-confirm="Roll forward? Idempotent — re-running overwrites prior roll-forward results for affected accounts."
          >
            <label className="block text-xs">
              <span className="font-medium text-zinc-600 dark:text-zinc-400">Source FY *</span>
              <select name="sourceId" required className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-950">
                <option value="">—</option>
                {fys.map((y) => (<option key={y.id} value={y.id}>{y.label}</option>))}
              </select>
            </label>
            <label className="block text-xs">
              <span className="font-medium text-zinc-600 dark:text-zinc-400">Target FY *</span>
              <select name="targetId" required className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-950">
                <option value="">—</option>
                {fys.map((y) => (<option key={y.id} value={y.id}>{y.label}</option>))}
              </select>
            </label>
            <label className="col-span-2 block text-xs">
              <span className="font-medium text-zinc-600 dark:text-zinc-400">Retained Earnings account *</span>
              <select name="retainedEarningsAccount" required className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-950">
                <option value="">— pick an equity account —</option>
                {equityAccounts.map((a) => (<option key={a.name} value={a.name}>{a.name}</option>))}
              </select>
            </label>
            <button
              type="submit"
              className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
            >
              ↻ Roll forward
            </button>
          </form>
          {equityAccounts.length === 0 && (
            <p className="mt-3 text-xs text-amber-700 dark:text-amber-300">
              No accounts have an EQUITY-nature group yet. Visit{" "}
              <Link href="/admin/groups" className="underline">/admin/groups</Link> and{" "}
              <Link href="/admin/accounts" className="underline">/admin/accounts</Link> to assign one
              before rolling forward.
            </p>
          )}
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
