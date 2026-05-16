// /admin/accounts/[id] — edit a single chart of accounts entry. Admin-only.

import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { toggleAccountActive, updateAccount } from "../actions";

export const metadata = { title: "Edit account — Admin" };

export default async function EditAccountPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  await requireRole(["admin"]);
  const { id } = await params;
  const sp = await searchParams;

  const account = await prisma.chartOfAccount.findUnique({
    where: { id },
    include: { _count: { select: { journals: true, openingBalances: true } } },
  });
  if (!account) notFound();

  const groups = await prisma.accountGroup.findMany({
    orderBy: [{ nature: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
    select: { id: true, name: true, nature: true },
  });

  const journalCount = account._count.journals;
  const openingCount = account._count.openingBalances;

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10 dark:bg-zinc-950">
      <div className="mx-auto max-w-xl">
        <div className="text-xs uppercase tracking-widest text-zinc-500">
          <Link href="/dashboard" className="hover:text-zinc-700 dark:hover:text-zinc-300">← Dashboard</Link>
          <span className="mx-1.5 text-zinc-400">/</span>
          <Link href="/admin/accounts" className="hover:text-zinc-700 dark:hover:text-zinc-300">Chart of accounts</Link>
        </div>

        <div className="mt-3 flex items-end justify-between gap-3">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            Edit account
          </h1>
          <Link
            href={`/ledger/${encodeURIComponent(account.name)}`}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            View ledger →
          </Link>
        </div>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          {journalCount} journal entr{journalCount === 1 ? "y" : "ies"} ·{" "}
          {openingCount} opening balance{openingCount === 1 ? "" : "s"} reference this account.
          {journalCount > 0 && (
            <>
              {" "}
              Renaming cascades automatically; deactivating hides it from new pickers but keeps
              history intact.
            </>
          )}
        </p>

        {sp.error && (
          <div className="mt-4 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
            {sp.error}
          </div>
        )}

        <form action={updateAccount} className="mt-6 space-y-4">
          <input type="hidden" name="id" value={account.id} />

          <Field label="Name" required>
            <input
              type="text"
              name="name"
              required
              defaultValue={account.name}
              className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950"
            />
          </Field>

          <Field label="Sl (display order)" required>
            <input
              type="number"
              name="sl"
              min={1}
              defaultValue={account.sl}
              required
              className="w-32 rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950"
            />
          </Field>

          <Field label="Normal balance" required>
            <div className="flex gap-3">
              <label className="flex items-center gap-2 rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700">
                <input
                  type="radio"
                  name="normalBalance"
                  value="DEBIT"
                  defaultChecked={account.normalBalance === "DEBIT"}
                />
                <span>DEBIT</span>
              </label>
              <label className="flex items-center gap-2 rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700">
                <input
                  type="radio"
                  name="normalBalance"
                  value="CREDIT"
                  defaultChecked={account.normalBalance === "CREDIT"}
                />
                <span>CREDIT</span>
              </label>
            </div>
          </Field>

          <Field label="Group">
            <select
              name="groupId"
              defaultValue={account.groupId ?? ""}
              className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950"
            >
              <option value="">— ungrouped —</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.nature.padEnd(9)} · {g.name}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Category (free text — optional)">
            <input
              type="text"
              name="category"
              defaultValue={account.category ?? ""}
              className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950"
            />
          </Field>

          <div className="flex items-center gap-3 pt-2">
            <button
              type="submit"
              className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900"
            >
              Save changes
            </button>
            <Link
              href="/admin/accounts"
              className="text-xs text-zinc-500 underline hover:text-zinc-700 dark:hover:text-zinc-300"
            >
              Cancel
            </Link>
          </div>
        </form>

        <section className="mt-10 border-t border-zinc-200 pt-6 dark:border-zinc-800">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">
            {account.isActive ? "Deactivate" : "Reactivate"}
          </h2>
          <p className="mt-2 text-xs text-zinc-500">
            {account.isActive
              ? "Hides this account from journal-entry pickers. Existing journals are unaffected."
              : "Makes this account selectable again on new journal entries."}
          </p>
          <form action={toggleAccountActive} className="mt-3">
            <input type="hidden" name="id" value={account.id} />
            <button
              type="submit"
              className={`rounded-md px-3 py-1.5 text-xs font-medium ${
                account.isActive
                  ? "border border-amber-400 text-amber-700 hover:bg-amber-50 dark:border-amber-700 dark:text-amber-300 dark:hover:bg-amber-950"
                  : "border border-emerald-400 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-700 dark:text-emerald-300 dark:hover:bg-emerald-950"
              }`}
            >
              {account.isActive ? "Deactivate account" : "Reactivate account"}
            </button>
          </form>
        </section>
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
