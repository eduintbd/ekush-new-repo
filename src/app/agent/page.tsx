// /agent — selling-agent landing (spec §6.2). Stub for now; commission
// dashboard fills in with task #12.

import Link from "next/link";
import { requireAgent } from "@/lib/auth";
import { signOut } from "@/app/login/actions";

export default async function AgentDashboardPage() {
  const profile = await requireAgent();

  return (
    <main className="min-h-screen bg-emerald-50/30 dark:bg-emerald-950/30">
      <header className="border-b border-emerald-200 bg-white px-6 py-4 dark:border-emerald-900 dark:bg-zinc-900">
        <div className="mx-auto flex max-w-6xl items-center justify-between">
          <div>
            <p className="text-xs uppercase tracking-widest text-emerald-700 dark:text-emerald-300">
              Selling agent
            </p>
            <h1 className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
              Agent dashboard
            </h1>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-zinc-600 dark:text-zinc-400">
              {profile.fullName ?? profile.email}
            </span>
            <form action={signOut}>
              <button className="rounded-md border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800">
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-6 py-10">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Your dashboard, sourced investors, and commission ledger appear here.
          Coming online with task #12.
        </p>

        <div className="mt-8 grid gap-4 sm:grid-cols-3">
          <PlaceholderCard label="AUM under my code" value="—" />
          <PlaceholderCard label="Accrued this quarter" value="—" />
          <PlaceholderCard label="Last paid quarter" value="—" />
        </div>

        <div className="mt-10 grid gap-4 sm:grid-cols-2">
          <Link
            href="/agent/investors"
            className="rounded-lg border border-emerald-200 bg-white p-5 dark:border-emerald-900 dark:bg-zinc-900"
          >
            <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">My investors →</p>
            <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
              Investors I sourced. Live join with the Ekush Web feed.
            </p>
          </Link>
          <Link
            href="/agent/commissions"
            className="rounded-lg border border-emerald-200 bg-white p-5 dark:border-emerald-900 dark:bg-zinc-900"
          >
            <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Commissions →</p>
            <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
              Upfront, trail, and clawback runs.
            </p>
          </Link>
        </div>
      </div>
    </main>
  );
}

function PlaceholderCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <p className="text-xs uppercase tracking-wider text-zinc-500">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">{value}</p>
    </div>
  );
}
