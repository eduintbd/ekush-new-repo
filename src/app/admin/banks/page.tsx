// /admin/banks — bank account master. Each row is a structured banking
// metadata record (bank name, branch, account number, IFSC, opening
// balance, reconciliation start) attached 1:1 to a CoA ledger.

import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { formatBdt } from "@/lib/format";
import { createBankAccount, deleteBankAccount, updateBankAccount } from "./actions";

type Search = { ok?: string; error?: string; edit?: string };

const TYPES = ["current", "savings", "std", "md", "fdr", "mobile_money", "other"];

const NAME_PATTERN =
  /(cash|bank|brac|ucb|bkash|nagad|rocket|mtbl|dbbl|ebl|std account|midland|premier|prime|nccb)/i;

export const metadata = { title: "Bank account master — Admin" };

export default async function BanksPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  await requireRole(["admin"]);
  const sp = await searchParams;

  const banks = await prisma.bankAccount
    .findMany({ orderBy: [{ isActive: "desc" }, { bankName: "asc" }] })
    .catch(() => []);

  const candidateAccounts = await prisma.chartOfAccount.findMany({
    where: { isActive: true, normalBalance: "DEBIT" },
    orderBy: { sl: "asc" },
    select: { name: true, group: { select: { name: true, nature: true } } },
  });
  const linkedNames = new Set(banks.map((b) => b.accountName));
  const linkable = candidateAccounts.filter(
    (a) =>
      !linkedNames.has(a.name) &&
      ((a.group?.name && /cash|bank/i.test(a.group.name)) || NAME_PATTERN.test(a.name)),
  );

  const editing = sp.edit ? banks.find((b) => b.id === sp.edit) : null;

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10 dark:bg-zinc-950">
      <div className="mx-auto max-w-6xl">
        <div className="text-xs uppercase tracking-widest text-zinc-500">
          <Link href="/dashboard" className="hover:text-zinc-700 dark:hover:text-zinc-300">← Dashboard</Link>
          <span className="mx-1.5 text-zinc-400">/</span>
          <span className="normal-case text-zinc-700 dark:text-zinc-300">Bank account master</span>
        </div>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Bank accounts
        </h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          {banks.length} structured bank record{banks.length === 1 ? "" : "s"}. Each one attaches to
          a CoA ledger and carries banking-specific metadata (account number, IFSC, opening balance,
          BRS start date).
        </p>

        {sp.ok && <Banner kind="success">{sp.ok}</Banner>}
        {sp.error && <Banner kind="error">{sp.error}</Banner>}

        {banks.length === 0 ? (
          <p className="mt-10 text-sm text-zinc-500">No bank records yet — add one below.</p>
        ) : (
          <div className="mt-6 overflow-x-auto rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
              <thead className="bg-zinc-50 dark:bg-zinc-950">
                <tr>
                  <Th>Ledger</Th>
                  <Th>Bank</Th>
                  <Th>Branch</Th>
                  <Th>Account #</Th>
                  <Th>Type</Th>
                  <Th align="right">Opening</Th>
                  <Th>BRS start</Th>
                  <Th>Status</Th>
                  <Th />
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {banks.map((b) => (
                  <tr key={b.id} className={!b.isActive ? "opacity-60" : ""}>
                    <Td className="font-medium">
                      <Link href={`/ledger/${encodeURIComponent(b.accountName)}`} className="underline-offset-2 hover:underline">
                        {b.accountName}
                      </Link>
                    </Td>
                    <Td>{b.bankName}</Td>
                    <Td className="text-xs text-zinc-500">{b.branch ?? "—"}</Td>
                    <Td className="font-mono text-xs">{b.accountNumber}</Td>
                    <Td className="text-xs uppercase">{b.accountType}</Td>
                    <Td align="right" className="font-mono text-xs">{formatBdt(Number(b.openingBalance))}</Td>
                    <Td className="text-xs text-zinc-500">
                      {b.reconciliationStart ? b.reconciliationStart.toISOString().slice(0, 10) : "—"}
                    </Td>
                    <Td>
                      {b.isActive ? (
                        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium uppercase text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">active</span>
                      ) : (
                        <span className="rounded-full bg-zinc-200 px-2 py-0.5 text-[10px] font-medium uppercase text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">inactive</span>
                      )}
                    </Td>
                    <Td>
                      <div className="flex items-center gap-2 text-[10px]">
                        <Link href={`/admin/banks?edit=${b.id}`} className="underline">edit</Link>
                        <form action={deleteBankAccount} className="inline">
                          <input type="hidden" name="id" value={b.id} />
                          <button type="submit" className="text-red-600 hover:underline dark:text-red-400">
                            delete
                          </button>
                        </form>
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Editor (create / update) */}
        <section className="mt-8 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">
              {editing ? `Edit "${editing.accountName}"` : "Add bank account"}
            </h2>
            {editing && (
              <Link href="/admin/banks" className="text-xs text-zinc-500 underline">
                Cancel edit
              </Link>
            )}
          </div>
          <form action={editing ? updateBankAccount : createBankAccount} className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {editing && <input type="hidden" name="id" value={editing.id} />}
            {!editing && (
              <label className="col-span-2 block text-xs">
                <span className="font-medium text-zinc-600 dark:text-zinc-400">Ledger account *</span>
                <select
                  name="accountName"
                  required
                  className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-950"
                >
                  <option value="">— pick a ledger —</option>
                  {linkable.map((a) => (
                    <option key={a.name} value={a.name}>{a.name}</option>
                  ))}
                </select>
              </label>
            )}
            <label className="col-span-2 block text-xs">
              <span className="font-medium text-zinc-600 dark:text-zinc-400">Bank name *</span>
              <input
                name="bankName"
                required
                defaultValue={editing?.bankName}
                placeholder="e.g. BRAC Bank Limited"
                className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-950"
              />
            </label>
            <label className="block text-xs">
              <span className="font-medium text-zinc-600 dark:text-zinc-400">Branch</span>
              <input
                name="branch"
                defaultValue={editing?.branch ?? ""}
                className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-950"
              />
            </label>
            <label className="block text-xs">
              <span className="font-medium text-zinc-600 dark:text-zinc-400">Account # *</span>
              <input
                name="accountNumber"
                required
                defaultValue={editing?.accountNumber}
                className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 font-mono dark:border-zinc-700 dark:bg-zinc-950"
              />
            </label>
            <label className="block text-xs">
              <span className="font-medium text-zinc-600 dark:text-zinc-400">Type</span>
              <select
                name="accountType"
                defaultValue={editing?.accountType ?? "current"}
                className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-950"
              >
                {TYPES.map((t) => (<option key={t} value={t}>{t}</option>))}
              </select>
            </label>
            <label className="block text-xs">
              <span className="font-medium text-zinc-600 dark:text-zinc-400">Currency</span>
              <input
                name="currency"
                defaultValue={editing?.currency ?? "BDT"}
                className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-950"
              />
            </label>
            <label className="block text-xs">
              <span className="font-medium text-zinc-600 dark:text-zinc-400">IFSC</span>
              <input name="ifsc" defaultValue={editing?.ifsc ?? ""} className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-950" />
            </label>
            <label className="block text-xs">
              <span className="font-medium text-zinc-600 dark:text-zinc-400">SWIFT</span>
              <input name="swift" defaultValue={editing?.swift ?? ""} className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-950" />
            </label>
            <label className="block text-xs">
              <span className="font-medium text-zinc-600 dark:text-zinc-400">Opening balance</span>
              <input
                type="number"
                step="0.01"
                name="openingBalance"
                defaultValue={editing ? Number(editing.openingBalance).toString() : "0"}
                className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 font-mono dark:border-zinc-700 dark:bg-zinc-950"
              />
            </label>
            <label className="block text-xs">
              <span className="font-medium text-zinc-600 dark:text-zinc-400">BRS start date</span>
              <input
                type="date"
                name="reconciliationStart"
                defaultValue={editing?.reconciliationStart?.toISOString().slice(0, 10) ?? ""}
                className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-950"
              />
            </label>
            <label className="col-span-2 block text-xs sm:col-span-3">
              <span className="font-medium text-zinc-600 dark:text-zinc-400">Notes</span>
              <input
                name="notes"
                defaultValue={editing?.notes ?? ""}
                className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-950"
              />
            </label>
            {editing && (
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  name="isActive"
                  defaultChecked={editing.isActive}
                  className="rounded border-zinc-400"
                />
                <span>Active</span>
              </label>
            )}
            <button
              type="submit"
              className="self-end rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
            >
              {editing ? "Save changes" : "+ Add bank account"}
            </button>
          </form>
        </section>
      </div>
    </main>
  );
}

function Banner({ kind, children }: { kind: "success" | "error"; children: React.ReactNode }) {
  const cls = kind === "success"
    ? "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
    : "border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-300";
  return <div className={`mt-4 rounded-md border px-3 py-2 text-sm ${cls}`}>{children}</div>;
}

function Th({ children, align = "left" }: { children?: React.ReactNode; align?: "left" | "right" }) {
  const a = align === "right" ? "text-right" : "text-left";
  return <th className={`${a} px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500`}>{children}</th>;
}

function Td({ children, align = "left", className = "" }: { children?: React.ReactNode; align?: "left" | "right"; className?: string }) {
  const a = align === "right" ? "text-right tabular-nums" : "text-left";
  return <td className={`${a} px-4 py-2 ${className}`}>{children}</td>;
}
