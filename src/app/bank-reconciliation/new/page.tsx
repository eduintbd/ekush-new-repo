// /bank-reconciliation/new — record a new bank statement (book vs statement
// balance comparison). The accountant enters statement opening + closing
// from the bank's letter/PDF; X-System reads the corresponding book balance
// on submit.

import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { saveBankStatement } from "../actions";

const NAME_PATTERN =
  /(cash|bank|brac|ucb|bkash|nagad|rocket|mtbl|dbbl|ebl|std account|midland|premier|prime|nccb)/i;

export const metadata = { title: "Record statement — BRS" };

export default async function NewBRSPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  await requireRole(["admin", "checker", "accountant"]);
  const sp = await searchParams;

  const fiscalYears = await prisma.fiscalYear
    .findMany({ orderBy: { startsOn: "desc" }, select: { id: true, label: true } })
    .catch(() => []);

  const accounts = await prisma.chartOfAccount
    .findMany({
      where: { isActive: true, normalBalance: "DEBIT" },
      orderBy: { sl: "asc" },
      select: { name: true, category: true },
    })
    .catch(() => []);
  const bankAccounts = accounts.filter(
    (a) => (a.category && /cash|bank/i.test(a.category)) || NAME_PATTERN.test(a.name),
  );

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10 dark:bg-zinc-950">
      <div className="mx-auto max-w-xl">
        <div className="text-xs uppercase tracking-widest text-zinc-500">
          <Link href="/dashboard" className="hover:text-zinc-700 dark:hover:text-zinc-300">← Dashboard</Link>
          <span className="mx-1.5 text-zinc-400">/</span>
          <Link href="/bank-reconciliation" className="hover:text-zinc-700 dark:hover:text-zinc-300">Bank Reconciliation</Link>
        </div>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Record bank statement
        </h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Enter the statement opening + closing balance as printed on the bank's letter. X-System
          will compare against the book balance computed from journals.
        </p>

        {sp.error && (
          <div className="mt-4 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
            {sp.error}
          </div>
        )}

        <form action={saveBankStatement} className="mt-6 space-y-4">
          <Field label="Bank / cash account" required>
            <select
              name="accountName"
              required
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            >
              <option value="">— pick an account —</option>
              {bankAccounts.map((a) => (
                <option key={a.name} value={a.name}>{a.name}</option>
              ))}
            </select>
            <p className="mt-1 text-xs text-zinc-500">
              Detected via category "Cash and bank balances" or name keyword.
            </p>
          </Field>

          <Field label="Fiscal year" required>
            <select
              name="fiscalYearId"
              required
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            >
              {fiscalYears.map((y) => (
                <option key={y.id} value={y.id}>{y.label}</option>
              ))}
            </select>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Period start" required>
              <input type="date" name="periodStart" required className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
            </Field>
            <Field label="Period end" required>
              <input type="date" name="periodEnd" required className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Statement opening balance">
              <input type="number" step="0.01" name="openingBalance" defaultValue="0" className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-mono tabular-nums dark:border-zinc-700 dark:bg-zinc-900" />
            </Field>
            <Field label="Statement closing balance" required>
              <input type="number" step="0.01" name="closingBalance" required className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-mono tabular-nums dark:border-zinc-700 dark:bg-zinc-900" />
            </Field>
          </div>

          <Field label="Source (filename or letter ref)">
            <input type="text" name="sourceFile" placeholder="e.g. BRAC_stmt_Mar2026.pdf" className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
          </Field>

          <Field label="Notes">
            <textarea name="notes" rows={3} className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
          </Field>

          <div className="flex items-center gap-3 pt-2">
            <button
              type="submit"
              className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900"
            >
              Save statement
            </button>
            <Link href="/bank-reconciliation" className="text-xs text-zinc-500 underline">Cancel</Link>
          </div>
        </form>
      </div>
    </main>
  );
}

function Field({ label, required = false, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500">
        {label}{required && <span className="ml-1 text-red-500">*</span>}
      </label>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}
