import Link from "next/link";

export default function Home() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-zinc-50 px-6 py-16 dark:bg-zinc-950">
      <div className="w-full max-w-2xl">
        <div className="mb-10">
          <p className="text-sm font-medium uppercase tracking-widest text-zinc-500">
            Ekush Wealth Management Limited
          </p>
          <h1 className="mt-2 text-4xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            Ekush ERP — X-System
          </h1>
          <p className="mt-4 text-base leading-7 text-zinc-600 dark:text-zinc-400">
            Back-office accounting and selling-agent commission portal. Replaces
            the F.S workbook as the day-to-day book of account; computes upfront,
            quarterly trail, and clawback commissions per the Selling Agent
            Agreement.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Link
            href="/login"
            className="rounded-lg border border-zinc-200 bg-white p-5 transition-colors hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:bg-zinc-800"
          >
            <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
              Staff portal →
            </p>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              Accountants, admins, auditors. Journals, trial balance, financial
              statements, year-end export.
            </p>
          </Link>

          <Link
            href="/agent/login"
            className="rounded-lg border border-zinc-200 bg-white p-5 transition-colors hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:bg-zinc-800"
          >
            <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
              Selling-agent portal →
            </p>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              Approved agents only. Sourced investors, AUM, accrued and paid
              commissions, clawback exposure.
            </p>
          </Link>
        </div>

        <p className="mt-10 text-xs text-zinc-500">
          Initial build — see <code className="font-mono">README.md</code> for status.
        </p>
      </div>
    </main>
  );
}
