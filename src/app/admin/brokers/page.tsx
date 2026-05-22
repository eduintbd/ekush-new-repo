// /admin/brokers — admin panel for the Broker master. Each row links
// a short code (UCB, PRIMEBANK) to the CoA accounts where its trades
// settle (broker BO ledger + optional margin-loan liability). The
// /trades/new dropdown reads active rows from here; adding a broker
// here means it appears on the trade form without any code change.

import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { createBroker, deleteBroker, updateBroker } from "./actions";

type Search = { ok?: string; error?: string; edit?: string };

export const metadata = { title: "Brokers — Admin" };

export default async function BrokersPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  await requireRole(["admin"]);
  const sp = await searchParams;

  const [brokers, debitAccounts, creditAccounts] = await Promise.all([
    prisma.broker
      .findMany({ orderBy: [{ isActive: "desc" }, { name: "asc" }] })
      .catch(() => []),
    prisma.chartOfAccount.findMany({
      where: { isActive: true, normalBalance: "DEBIT" },
      orderBy: { name: "asc" },
      select: { name: true },
    }),
    prisma.chartOfAccount.findMany({
      where: { isActive: true, normalBalance: "CREDIT" },
      orderBy: { name: "asc" },
      select: { name: true },
    }),
  ]);

  const editing = sp.edit ? brokers.find((b) => b.code === sp.edit) ?? null : null;

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10 dark:bg-zinc-950">
      <div className="mx-auto max-w-5xl">
        <div className="text-xs uppercase tracking-widest text-zinc-500">
          <Link href="/dashboard" className="hover:text-zinc-700 dark:hover:text-zinc-300">← Dashboard</Link>
          <span className="mx-1.5 text-zinc-400">/</span>
          <span className="normal-case text-zinc-700 dark:text-zinc-300">Brokers</span>
        </div>
        <h1 className="mt-3 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">Brokers</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Panel of brokers. Each broker links to its BO/current-account ledger and (optionally)
          a margin-loan liability ledger in the CoA. Active rows appear in the broker dropdown
          on <Link href="/trades/new" className="underline">/trades/new</Link>.
        </p>

        <div className="mt-6 overflow-x-auto rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
            <thead className="bg-zinc-50 dark:bg-zinc-950">
              <tr>
                <Th>Code</Th>
                <Th>Name</Th>
                <Th>Broker BO account</Th>
                <Th>Margin loan account</Th>
                <Th>Status</Th>
                <Th>&nbsp;</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {brokers.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-sm text-zinc-500">
                    No brokers yet. Add one below.
                  </td>
                </tr>
              ) : (
                brokers.map((b) => (
                  <tr key={b.code} className={b.isActive ? "" : "opacity-50"}>
                    <Td className="font-mono text-xs">{b.code}</Td>
                    <Td className="text-zinc-700 dark:text-zinc-300">{b.name}</Td>
                    <Td className="text-xs text-zinc-500">{b.brokerBoAccount}</Td>
                    <Td className="text-xs text-zinc-500">{b.marginLoanAccount ?? "—"}</Td>
                    <Td>
                      {b.isActive ? (
                        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium uppercase text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">active</span>
                      ) : (
                        <span className="rounded-full bg-zinc-200 px-2 py-0.5 text-[10px] font-medium uppercase text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">inactive</span>
                      )}
                    </Td>
                    <Td>
                      <div className="flex items-center gap-2 text-[10px]">
                        <Link href={`/admin/brokers?edit=${b.code}`} className="underline">edit</Link>
                        <form
                          action={deleteBroker}
                          className="inline"
                          data-confirm={`Remove broker ${b.code}? Refused if any trade references it.`}
                        >
                          <input type="hidden" name="code" value={b.code} />
                          <button type="submit" className="text-red-600 hover:underline dark:text-red-400">
                            delete
                          </button>
                        </form>
                      </div>
                    </Td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Add / edit form */}
        <section className="mt-8 rounded-lg border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">
            {editing ? `Edit ${editing.code}` : "+ Add broker"}
          </h2>
          <form action={editing ? updateBroker : createBroker} className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {editing ? (
              <input type="hidden" name="code" value={editing.code} />
            ) : (
              <Field label="Code *" name="code" placeholder="UCB / PRIMEBANK / ICB" required uppercase />
            )}
            <Field label="Name *" name="name" required defaultValue={editing?.name ?? ""} placeholder="UCB Securities" />
            <div /> {/* spacer for grid alignment when adding */}
            <SelectField
              label="Broker BO account *"
              name="brokerBoAccount"
              required
              defaultValue={editing?.brokerBoAccount ?? ""}
            >
              <option value="">— pick —</option>
              {debitAccounts.map((a) => (
                <option key={a.name} value={a.name}>{a.name}</option>
              ))}
            </SelectField>
            <SelectField
              label="Margin loan account (optional)"
              name="marginLoanAccount"
              defaultValue={editing?.marginLoanAccount ?? ""}
            >
              <option value="">— none —</option>
              {creditAccounts.map((a) => (
                <option key={a.name} value={a.name}>{a.name}</option>
              ))}
            </SelectField>
            <Field label="Notes" name="notes" defaultValue={editing?.notes ?? ""} />
            {editing && (
              <SelectField label="Status" name="isActive" defaultValue={String(editing.isActive)}>
                <option value="true">active</option>
                <option value="false">inactive</option>
              </SelectField>
            )}
            <div className="col-span-2 sm:col-span-3 mt-2 flex items-center gap-3">
              <button
                type="submit"
                className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900"
              >
                {editing ? "Save changes" : "Add broker"}
              </button>
              {editing && (
                <Link href="/admin/brokers" className="text-xs text-zinc-500 underline hover:text-zinc-700 dark:hover:text-zinc-300">
                  Cancel
                </Link>
              )}
            </div>
          </form>
        </section>
      </div>
    </main>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="text-left px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
      {children}
    </th>
  );
}

function Td({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <td className={`text-left px-4 py-2 ${className}`}>{children}</td>;
}

function Field({
  label,
  name,
  placeholder,
  required = false,
  defaultValue,
  uppercase = false,
}: {
  label: string;
  name: string;
  placeholder?: string;
  required?: boolean;
  defaultValue?: string;
  uppercase?: boolean;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium uppercase tracking-wider text-zinc-600 dark:text-zinc-400">
        {label}
      </span>
      <input
        name={name}
        placeholder={placeholder}
        required={required}
        defaultValue={defaultValue}
        style={uppercase ? { textTransform: "uppercase" } : undefined}
        className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
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
        className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
      >
        {children}
      </select>
    </label>
  );
}
