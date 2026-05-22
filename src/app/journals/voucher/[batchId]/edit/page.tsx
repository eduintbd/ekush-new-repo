// /journals/voucher/[batchId]/edit — modify an existing compound entry.
// Loads the current batch, pre-fills the same form used by /journals/new,
// and submits to updateJournalBatch (which replaces the whole batch
// in-place, keeping voucherNo and audit lineage).

import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole, canEdit } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { updateJournalBatch } from "@/app/journals/actions";
import { JournalLines } from "@/app/journals/new/lines";

type Search = { err?: string; msg?: string };

export const metadata = { title: "Edit journal entry — Staff portal" };

export default async function EditJournalPage({
  params,
  searchParams,
}: {
  params: Promise<{ batchId: string }>;
  searchParams: Promise<Search>;
}) {
  const profile = await requireRole(["admin", "accountant"]);
  const { batchId } = await params;
  const sp = await searchParams;

  const lines = await prisma.journal.findMany({
    where: { batchId },
    orderBy: [{ debit: "desc" }, { credit: "asc" }, { createdAt: "asc" }],
    include: { fiscalYear: { select: { id: true, label: true, isClosed: true } } },
  });
  if (lines.length === 0) notFound();
  const head = lines[0];

  if (head.fiscalYear.isClosed || !canEdit(profile)) {
    return (
      <main className="min-h-screen bg-zinc-50 px-6 py-10 dark:bg-zinc-950">
        <div className="mx-auto max-w-3xl">
          <Link href="/day-book" className="text-xs uppercase tracking-widest text-zinc-500 hover:text-zinc-700">
            ← Day book
          </Link>
          <p className="mt-10 text-sm text-red-700 dark:text-red-300">
            This voucher cannot be edited — the fiscal year is closed.
          </p>
        </div>
      </main>
    );
  }

  const fiscalYears = await prisma.fiscalYear
    .findMany({ where: { isClosed: false }, orderBy: { startsOn: "desc" } })
    .catch(() => []);
  const accounts = await prisma.chartOfAccount
    .findMany({ where: { isActive: true }, orderBy: { sl: "asc" }, select: { name: true } })
    .catch(() => []);

  const initial = lines.map((l) => ({
    account: l.accountName,
    debit: Number(l.debit),
    credit: Number(l.credit),
  }));

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10 dark:bg-zinc-950">
      <div className="mx-auto max-w-3xl">
        <div className="text-xs uppercase tracking-widest text-zinc-500">
          <Link href="/day-book" className="hover:text-zinc-700 dark:hover:text-zinc-300">← Day book</Link>
          <span className="mx-1.5 text-zinc-400">/</span>
          <Link
            href={`/journals/voucher/${batchId}`}
            className="hover:text-zinc-700 dark:hover:text-zinc-300"
          >
            {head.voucherNo ?? "voucher"}
          </Link>
          <span className="mx-1.5 text-zinc-400">/</span>
          <span className="text-zinc-700 dark:text-zinc-300">edit</span>
        </div>
        <h1 className="mt-2 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
          Edit journal entry
        </h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Voucher <span className="font-mono">{head.voucherNo ?? "—"}</span>. Saving replaces
          every line on this voucher — Σ debit must equal Σ credit.
        </p>

        {sp.err && <ErrorBanner err={sp.err} msg={sp.msg} />}

        <form action={updateJournalBatch} className="mt-8 space-y-4">
          <input type="hidden" name="batchId" value={batchId} />
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Date"
              name="entryDate"
              type="date"
              required
              defaultValue={head.entryDate.toISOString().slice(0, 10)}
            />
            <SelectField label="Fiscal year" name="fiscalYearId" required defaultValue={head.fiscalYear.id}>
              {fiscalYears.length === 0 && <option value="">No open fiscal years</option>}
              {fiscalYears.map((y) => (
                <option key={y.id} value={y.id}>
                  {y.label}
                </option>
              ))}
            </SelectField>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Field label="Txn type" name="txnType" defaultValue={head.txnType ?? "j"} />
            <Field
              label="Fund (optional)"
              name="fundCode"
              placeholder="EFUF, EGF, ESRF"
              defaultValue={head.fundCode ?? ""}
            />
            <Field
              label="Investor (optional)"
              name="investorCode"
              defaultValue={head.investorCode ?? ""}
            />
            <Field
              label="Instrument (optional)"
              name="instrumentCode"
              placeholder="BRACBANK, BATBC, …"
              defaultValue={head.instrumentCode ?? ""}
            />
          </div>
          <Field
            label="Description"
            name="description"
            defaultValue={head.description ?? ""}
          />

          <JournalLines
            accounts={accounts.map((a) => a.name)}
            initial={initial}
            submitLabel="Save changes"
          />
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
  defaultValue,
  children,
}: {
  label: string;
  name: string;
  required?: boolean;
  defaultValue?: string;
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
        defaultValue={defaultValue}
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
