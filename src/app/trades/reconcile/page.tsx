// /trades/reconcile — upload the year's broker/fund ledgers and get a
// report of what's missing or wrongly entered in x-system's trade
// journals. Each finding deep-links into /trades/<id>/edit (or /trades/new
// for missing ones) so the accountant fixes it in one click.

import Link from "next/link";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ReconcileClient } from "./reconcile-client";

export const metadata = { title: "Ledger reconciliation — Staff portal" };

export default async function ReconcilePage() {
  await requireRole(["admin", "checker", "accountant"]);
  const fiscalYears = await prisma.fiscalYear
    .findMany({ orderBy: { startsOn: "desc" }, select: { id: true, label: true } })
    .catch(() => []);
  if (fiscalYears.length === 0) redirect("/trades?error=No+fiscal+year");

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10 dark:bg-zinc-950">
      <div className="mx-auto max-w-5xl print-area">
        <div className="no-print text-xs uppercase tracking-widest text-zinc-500">
          <Link href="/dashboard" className="hover:text-zinc-700 dark:hover:text-zinc-300">← Dashboard</Link>
          <span className="mx-1.5 text-zinc-400">/</span>
          <Link href="/trades" className="hover:text-zinc-700 dark:hover:text-zinc-300">Trades</Link>
        </div>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">Ledger reconciliation</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Upload the broker statements and fund-subscription ledger for the year. x-system compares them against its trade
          journals and reports every missing, wrong, mis-dated, or out-of-sync entry — then links you straight to the fix.
        </p>
        <ReconcileClient fiscalYears={fiscalYears} defaultFyId={fiscalYears[0].id} />
      </div>
    </main>
  );
}
