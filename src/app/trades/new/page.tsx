// /trades/new — single-form entry for one buy/sell. On submit:
//   1. Trade row inserted.
//   2. If SELL, weighted-avg cost basis + realised P&L snapshotted onto
//      the row from prior-trade history for the same instrument.
//   3. A Journal voucher (prefix BV / SV) is auto-posted to the day-book.
//
// The form inherits pending-state + flash-toast from the global
// <FormGuard> / <FlashToast> — no per-page wiring.

import Link from "next/link";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { createTrade } from "@/app/trades/actions";

type Search = { error?: string; defaultSide?: "BUY" | "SELL" };

export const metadata = { title: "New trade — Staff portal" };

export default async function NewTradePage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  await requireRole(["admin", "accountant"]);
  const sp = await searchParams;

  const [fiscalYears, instruments, banks, brokers] = await Promise.all([
    prisma.fiscalYear
      .findMany({ where: { isClosed: false }, orderBy: { startsOn: "desc" } })
      .catch(() => []),
    prisma.instrument
      .findMany({ where: { isActive: true }, orderBy: { code: "asc" } })
      .catch(() => []),
    prisma.bankAccount
      .findMany({ where: { isActive: true }, orderBy: { accountName: "asc" } })
      .catch(() => []),
    prisma.broker
      .findMany({ where: { isActive: true }, orderBy: { name: "asc" } })
      .catch(() => []),
  ]);

  if (fiscalYears.length === 0) {
    redirect("/trades?error=No+open+fiscal+year");
  }
  if (instruments.length === 0) {
    redirect("/trades?error=No+active+instruments+%E2%80%94+seed+them+first");
  }
  if (banks.length === 0) {
    redirect("/trades?error=No+active+bank+accounts");
  }
  if (brokers.length === 0) {
    redirect("/trades?error=No+active+brokers+%E2%80%94+add+one+at+%2Fadmin%2Fbrokers");
  }

  const today = new Date().toISOString().slice(0, 10);

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10 dark:bg-zinc-950">
      <div className="mx-auto max-w-2xl">
        <div className="text-xs uppercase tracking-widest text-zinc-500">
          <Link href="/dashboard" className="hover:text-zinc-700 dark:hover:text-zinc-300">
            ← Dashboard
          </Link>
          <span className="mx-1.5 text-zinc-400">/</span>
          <Link href="/trades" className="hover:text-zinc-700 dark:hover:text-zinc-300">
            Trades
          </Link>
        </div>
        <h1 className="mt-2 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">New trade</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          On save, the matching journal voucher (BV / SV) is auto-posted to the day-book. For
          SELL, weighted-average cost basis and realised P&amp;L are computed from prior trades
          on the same instrument.
        </p>

        {sp.error && (
          <div className="mt-4 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
            {sp.error}
          </div>
        )}

        <form action={createTrade} className="mt-8 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Trade date" name="tradeDate" type="date" required defaultValue={today} />
            <SelectField label="Fiscal year" name="fiscalYearId" required defaultValue={fiscalYears[0].id}>
              {fiscalYears.map((y) => (
                <option key={y.id} value={y.id}>
                  {y.label}
                </option>
              ))}
            </SelectField>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <SelectField label="Side" name="side" required defaultValue={sp.defaultSide ?? "BUY"}>
              <option value="BUY">BUY</option>
              <option value="SELL">SELL</option>
            </SelectField>
            <SelectField label="Broker" name="brokerCode" required defaultValue={brokers[0]?.code}>
              {brokers.map((b) => (
                <option key={b.code} value={b.code}>
                  {b.name}
                </option>
              ))}
            </SelectField>
            <SelectField label="Instrument" name="instrumentCode" required>
              <option value="">— pick —</option>
              {instruments.map((i) => (
                <option key={i.code} value={i.code}>
                  {i.code} · {i.name}
                </option>
              ))}
            </SelectField>
          </div>

          <div className="grid grid-cols-1 gap-3">
            <SelectField label="Settlement account" name="bankAccount" required>
              <option value="">— pick —</option>
              <optgroup label="Banks">
                {banks
                  .filter((b) => b.accountType !== "mobile_money")
                  .map((b) => (
                    <option key={b.id} value={b.accountName}>
                      {b.accountName}
                    </option>
                  ))}
              </optgroup>
              <optgroup label="Brokers (BO + Margin)">
                {brokers.flatMap((b) => {
                  const bo = (
                    <option key={`${b.code}-bo`} value={b.brokerBoAccount}>
                      {b.name} — BO{b.accountNumber ? ` (${b.accountNumber})` : ""}
                    </option>
                  );
                  return b.marginLoanAccount
                    ? [
                        bo,
                        <option key={`${b.code}-margin`} value={b.marginLoanAccount}>
                          {b.name} — Margin Loan
                        </option>,
                      ]
                    : [bo];
                })}
              </optgroup>
              <optgroup label="Mobile money">
                {banks
                  .filter((b) => b.accountType === "mobile_money")
                  .map((b) => (
                    <option key={b.id} value={b.accountName}>
                      {b.accountName}
                    </option>
                  ))}
              </optgroup>
            </SelectField>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <Field label="Quantity" name="quantity" type="number" step="0.0001" min="0" required />
            <Field label="Rate (BDT)" name="rate" type="number" step="0.000001" min="0" required />
            <div>
              <label className="block">
                <span className="text-xs font-medium uppercase tracking-wider text-zinc-600 dark:text-zinc-400">
                  Gross
                </span>
                <input
                  disabled
                  placeholder="qty × rate"
                  className="mt-1 block w-full rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950"
                />
              </label>
              <p className="mt-1 text-[10px] text-zinc-500">Calculated server-side.</p>
            </div>
          </div>

          <Field label="Remarks (optional)" name="remarks" placeholder="P Buy / IPO / Right share / …" />

          <button
            type="submit"
            className="mt-2 w-full rounded-md bg-zinc-900 py-2.5 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            Save trade
          </button>
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
  step,
  min,
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  defaultValue?: string;
  placeholder?: string;
  step?: string;
  min?: string;
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
        step={step}
        min={min}
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
