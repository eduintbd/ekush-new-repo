// /journals/new — compound journal entry form. Pure server-rendered for the
// happy path; client component below is only used to add/remove lines and
// show the live Σdebit/Σcredit totals.

import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { createJournal } from "@/app/journals/actions";
import { JournalLines } from "./lines";

type Search = { err?: string; msg?: string };

export const metadata = { title: "New journal entry — Staff portal" };

export default async function NewJournalPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  await requireRole(["admin", "accountant"]);
  const sp = await searchParams;

  const fiscalYears = await prisma.fiscalYear
    .findMany({ where: { isClosed: false }, orderBy: { startsOn: "desc" } })
    .catch(() => []);
  const accounts = await prisma.chartOfAccount
    .findMany({ where: { isActive: true }, orderBy: { sl: "asc" }, select: { name: true } })
    .catch(() => []);

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10 dark:bg-zinc-950">
      <div className="mx-auto max-w-3xl">
        <div className="text-xs uppercase tracking-widest text-zinc-500">
          <Link href="/dashboard" className="hover:text-zinc-700 dark:hover:text-zinc-300">← Dashboard</Link>
          <span className="mx-1.5 text-zinc-400">/</span>
          <Link href="/journals" className="hover:text-zinc-700 dark:hover:text-zinc-300">Journals</Link>
        </div>
        <h1 className="mt-2 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
          New journal entry
        </h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Compound entry — add lines until Σ debit = Σ credit. The submit button
          stays disabled until the totals match.
        </p>

        {sp.err && <ErrorBanner err={sp.err} msg={sp.msg} />}

        <form action={createJournal} className="mt-8 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Date" name="entryDate" type="date" required />
            <SelectField label="Fiscal year" name="fiscalYearId" required>
              {fiscalYears.length === 0 && <option value="">No open fiscal years</option>}
              {fiscalYears.map((y) => (
                <option key={y.id} value={y.id}>
                  {y.label}
                </option>
              ))}
            </SelectField>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Field label="Txn type" name="txnType" defaultValue="j" />
            <Field label="Fund (optional)" name="fundCode" placeholder="EFUF, EGF, ESRF" />
            <Field label="Investor (optional)" name="investorCode" />
            <Field
              label="Instrument (optional)"
              name="instrumentCode"
              placeholder="BRACBANK, BATBC, …"
            />
          </div>
          <Field label="Description" name="description" />

          <JournalLines accounts={accounts.map((a) => a.name)} />
        </form>
      </div>
    </main>
  );
}

function Field({
  label,
  name,
  type = "text",
  required = false,
  defaultValue,
  placeholder,
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  defaultValue?: string;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium uppercase tracking-wider text-zinc-600 dark:text-zinc-400">
        {label}
      </span>
      <input
        name={name}
        type={type}
        required={required}
        defaultValue={defaultValue}
        placeholder={placeholder}
        className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
      />
    </label>
  );
}

function SelectField({
  label,
  name,
  required = false,
  children,
}: {
  label: string;
  name: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium uppercase tracking-wider text-zinc-600 dark:text-zinc-400">
        {label}
      </span>
      <select
        name={name}
        required={required}
        className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
      >
        {children}
      </select>
    </label>
  );
}

function ErrorBanner({ err, msg }: { err: string; msg?: string }) {
  let body = "Something went wrong.";
  if (err === "unbalanced") {
    try {
      const o = msg ? JSON.parse(msg) : null;
      body = `Σ debit (${o?.debitTotal}) ≠ Σ credit (${o?.creditTotal}).`;
    } catch { /* swallow */ }
  } else if (err === "fy_closed") body = "Fiscal year is closed.";
  else if (err === "fy_out_of_range") body = "Date is outside the selected fiscal year.";
  else if (err === "unknown_account") {
    try {
      const o = msg ? JSON.parse(msg) : null;
      body = `Unknown account: "${o?.account}".`;
    } catch { /* swallow */ }
  }
  return (
    <div className="mt-4 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
      {body}
    </div>
  );
}
