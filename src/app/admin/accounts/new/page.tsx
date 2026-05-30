// /admin/accounts/new — create a new chart of accounts entry. Admin-only.

import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { createAccount } from "../actions";

export const metadata = { title: "New account — Admin" };

const COMMON_CATEGORIES = [
  "Assets",
  "Liabilities",
  "Equity",
  "Income",
  "Expenses",
  "Investments",
];

export default async function NewAccountPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  await requireRole(["admin", "checker"]);
  const sp = await searchParams;

  const max = await prisma.chartOfAccount.aggregate({ _max: { sl: true } });
  const suggestedSl = (max._max.sl ?? 0) + 1;

  const groups = await prisma.accountGroup.findMany({
    orderBy: [{ nature: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
    select: { id: true, name: true, nature: true },
  });

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10 dark:bg-zinc-950">
      <div className="mx-auto max-w-xl">
        <div className="text-xs uppercase tracking-widest text-zinc-500">
          <Link href="/dashboard" className="hover:text-zinc-700 dark:hover:text-zinc-300">← Dashboard</Link>
          <span className="mx-1.5 text-zinc-400">/</span>
          <Link href="/admin/accounts" className="hover:text-zinc-700 dark:hover:text-zinc-300">Chart of accounts</Link>
        </div>

        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          New account
        </h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          Adds a row to the chart of accounts. The <strong>name</strong> becomes the foreign-key
          target for journal entries — choose carefully.
        </p>

        {sp.error && (
          <div className="mt-4 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
            {sp.error}
          </div>
        )}

        <form action={createAccount} className="mt-6 space-y-4">
          <Field label="Name" required>
            <input
              type="text"
              name="name"
              required
              placeholder="e.g. Bank charges"
              className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950"
            />
            <p className="mt-1 text-xs text-zinc-500">
              Must be unique. Renames cascade to existing journal entries.
            </p>
          </Field>

          <Field label="Sl (display order)">
            <input
              type="number"
              name="sl"
              min={1}
              defaultValue={suggestedSl}
              className="w-32 rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950"
            />
            <p className="mt-1 text-xs text-zinc-500">
              Leave as suggested ({suggestedSl}) to append at the end.
            </p>
          </Field>

          <Field label="Normal balance" required>
            <div className="flex gap-3">
              <label className="flex items-center gap-2 rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700">
                <input type="radio" name="normalBalance" value="DEBIT" required defaultChecked />
                <span>DEBIT</span>
              </label>
              <label className="flex items-center gap-2 rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700">
                <input type="radio" name="normalBalance" value="CREDIT" />
                <span>CREDIT</span>
              </label>
            </div>
            <p className="mt-1 text-xs text-zinc-500">
              Assets + expenses = DEBIT. Liabilities + equity + income = CREDIT.
            </p>
          </Field>

          <Field label="Group">
            <select
              name="groupId"
              className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950"
            >
              <option value="">— pick a group —</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.nature.padEnd(9)} · {g.name}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-zinc-500">
              Drives statement placement (Assets / Liabilities / Equity / Income / Expenses).
            </p>
          </Field>

          <Field label="Category (free text — optional)">
            <input
              type="text"
              name="category"
              list="account-categories"
              placeholder="e.g. Operating expenses"
              className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950"
            />
            <datalist id="account-categories">
              {COMMON_CATEGORIES.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </Field>

          <div className="flex items-center gap-3 pt-2">
            <button
              type="submit"
              className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900"
            >
              Create account
            </button>
            <Link
              href="/admin/accounts"
              className="text-xs text-zinc-500 underline hover:text-zinc-700 dark:hover:text-zinc-300"
            >
              Cancel
            </Link>
          </div>
        </form>
      </div>
    </main>
  );
}

function Field({
  label,
  required = false,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500">
        {label}
        {required && <span className="ml-1 text-red-500">*</span>}
      </label>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}
