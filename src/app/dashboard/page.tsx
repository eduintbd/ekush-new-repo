// /dashboard — staff portal landing (spec §6.1).
// Spec calls for: FY summary card, journals last-10, alerts (TB out of balance,
// BS out of balance, suspense > 0). Stub for now — fills out as the
// data sources land.

import Link from "next/link";
import { requireStaff } from "@/lib/auth";
import { signOut } from "@/app/login/actions";

export default async function DashboardPage() {
  const profile = await requireStaff();

  return (
    <main className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <header className="border-b border-zinc-200 bg-white px-6 py-4 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mx-auto flex max-w-6xl items-center justify-between">
          <div>
            <p className="text-xs uppercase tracking-widest text-zinc-500">Staff portal</p>
            <h1 className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
              Dashboard
            </h1>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-zinc-600 dark:text-zinc-400">
              {profile.fullName ?? profile.email}{" "}
              <span className="ml-2 inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                {profile.role}
              </span>
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
          Quick links — full dashboard coming as the data lands.
        </p>
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <NavCard href="/trial-balance" title="Trial Balance" desc="Per-account net debit / net credit for the selected fiscal year." />
          <NavCard href="/journals" title="Journals" desc="Browse and enter compound journal entries (coming soon)." disabled />
          <NavCard href="/balance-sheet" title="Balance Sheet" desc="Statement of Financial Position (coming soon)." disabled />
          <NavCard href="/income-statement" title="Income Statement" desc="P&L + OCI (coming soon)." disabled />
          <NavCard href="/notes" title="Notes" desc="Notes 4–27 (coming soon)." disabled />
          <NavCard href="/agents" title="Selling agents" desc="Approve, suspend, manage terms history (coming soon)." disabled />
        </div>
      </div>
    </main>
  );
}

function NavCard({
  href,
  title,
  desc,
  disabled = false,
}: {
  href: string;
  title: string;
  desc: string;
  disabled?: boolean;
}) {
  const card = (
    <div
      className={`rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900 ${
        disabled ? "opacity-60" : "transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800"
      }`}
    >
      <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">{title}</p>
      <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">{desc}</p>
    </div>
  );
  return disabled ? card : <Link href={href}>{card}</Link>;
}
