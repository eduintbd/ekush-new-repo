// /receivables — aging report for Management Fee Accrued (and any other
// receivable accounts). Walks debits in chronological order and settles
// them FIFO with the cumulative credit pool. Whatever isn't settled is
// outstanding; bucket by age (today − debit_date).

import Link from "next/link";
import { requireStaff } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { formatBdt } from "@/lib/format";
import { PrintButton } from "@/components/print-button";

type Search = { account?: string; asOf?: string };

const RECEIVABLE_ACCOUNTS = [
  "Management Fee Accrued",
  "AIT Receivables against Management Fee",
  "Other Receivables",
  "Dividend Receivable",
];

export const metadata = { title: "Receivables aging — Staff portal" };

export default async function ReceivablesPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  await requireStaff();
  const sp = await searchParams;

  // Discover which receivable-style accounts actually exist in CoA
  const candidates = await prisma.chartOfAccount.findMany({
    where: { name: { in: RECEIVABLE_ACCOUNTS } },
    select: { name: true, normalBalance: true, _count: { select: { journals: true } } },
  });
  const availableAccounts = candidates.filter((c) => c._count.journals > 0);
  const selectedAccount = sp.account ?? availableAccounts[0]?.name ?? "Management Fee Accrued";

  const asOf = sp.asOf ? new Date(sp.asOf) : new Date();

  // Pull all journal lines on the selected account up to as-of date
  const lines = await prisma.journal.findMany({
    where: { accountName: selectedAccount, entryDate: { lte: asOf } },
    orderBy: [{ entryDate: "asc" }, { createdAt: "asc" }],
    select: { id: true, entryDate: true, description: true, debit: true, credit: true, fundCode: true, voucherNo: true },
  });

  // FIFO settlement: each debit creates an outstanding receivable. Each
  // credit clears outstanding receivables oldest-first.
  type OpenItem = {
    id: string;
    entryDate: Date;
    description: string | null;
    fundCode: string | null;
    voucherNo: string | null;
    original: number;
    remaining: number;
  };
  const openQueue: OpenItem[] = [];
  for (const l of lines) {
    const d = Number(l.debit);
    const c = Number(l.credit);
    if (d > 0) {
      openQueue.push({
        id: l.id,
        entryDate: l.entryDate,
        description: l.description,
        fundCode: l.fundCode,
        voucherNo: l.voucherNo,
        original: d,
        remaining: d,
      });
    } else if (c > 0) {
      let toSettle = c;
      for (const item of openQueue) {
        if (toSettle <= 0) break;
        if (item.remaining <= 0) continue;
        const apply = Math.min(item.remaining, toSettle);
        item.remaining -= apply;
        toSettle -= apply;
      }
    }
  }

  const open = openQueue.filter((i) => i.remaining > 0.005);

  // Bucket by age
  type Bucket = { label: string; min: number; max: number; total: number; items: OpenItem[] };
  const buckets: Bucket[] = [
    { label: "0–30 days", min: 0, max: 30, total: 0, items: [] },
    { label: "31–60 days", min: 31, max: 60, total: 0, items: [] },
    { label: "61–90 days", min: 61, max: 90, total: 0, items: [] },
    { label: "91–180 days", min: 91, max: 180, total: 0, items: [] },
    { label: "180+ days", min: 181, max: 9999, total: 0, items: [] },
  ];
  for (const item of open) {
    const ageMs = asOf.getTime() - item.entryDate.getTime();
    const ageDays = Math.max(0, Math.floor(ageMs / 86400000));
    const b = buckets.find((x) => ageDays >= x.min && ageDays <= x.max)!;
    b.total += item.remaining;
    b.items.push(item);
  }

  // Per-fund summary
  const byFund = new Map<string, number>();
  for (const item of open) {
    const k = item.fundCode ?? "(unfunded)";
    byFund.set(k, (byFund.get(k) ?? 0) + item.remaining);
  }
  const fundRows = Array.from(byFund.entries()).sort((a, b) => b[1] - a[1]);

  const totalOpen = open.reduce((s, i) => s + i.remaining, 0);

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10 dark:bg-zinc-950">
      <div className="mx-auto max-w-7xl">
        <Link href="/dashboard" className="text-xs uppercase tracking-widest text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
          ← Dashboard
        </Link>
        <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-widest text-zinc-500">Staff portal</p>
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
              Receivables aging
            </h1>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              {selectedAccount} · as of {asOf.toISOString().slice(0, 10)} · open balance{" "}
              <strong>{formatBdt(totalOpen)} Dr</strong> ({open.length} item{open.length === 1 ? "" : "s"})
            </p>
          </div>
          <form className="flex items-end gap-2 text-sm">
            <label className="block">
              <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
                Account
              </span>
              <select
                name="account"
                defaultValue={selectedAccount}
                className="mt-1 block rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-900"
              >
                {availableAccounts.length === 0 && <option value="">(no receivable accounts)</option>}
                {availableAccounts.map((a) => (
                  <option key={a.name} value={a.name}>{a.name}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
                As of
              </span>
              <input
                type="date"
                name="asOf"
                defaultValue={asOf.toISOString().slice(0, 10)}
                className="mt-1 block rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-900"
              />
            </label>
            <button className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">
              Apply
            </button>
            <a
              href={`/api/exports/csv/receivables?account=${encodeURIComponent(selectedAccount)}&asOf=${asOf.toISOString().slice(0, 10)}`}
              className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800"
            >
              ⬇ CSV
            </a>
            <PrintButton />
          </form>
        </div>

        {/* Bucket tiles */}
        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {buckets.map((b) => (
            <div key={b.label} className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">{b.label}</p>
              <p className="mt-1 font-mono text-base tabular-nums text-zinc-900 dark:text-zinc-50">
                {b.total > 0.005 ? formatBdt(b.total) : "—"}
              </p>
              <p className="mt-0.5 text-[10px] text-zinc-500">
                {b.items.length} item{b.items.length === 1 ? "" : "s"}
              </p>
            </div>
          ))}
        </div>

        {/* Per-fund split */}
        {fundRows.length > 0 && (
          <section className="mt-6">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">By fund</h2>
            <div className="mt-2 grid gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {fundRows.map(([fund, amt]) => (
                <div key={fund} className="flex items-center justify-between rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-900">
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                    {fund}
                  </span>
                  <span className="font-mono text-xs tabular-nums">{formatBdt(amt)}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Detail by bucket */}
        <section className="mt-8 space-y-4">
          {buckets.filter((b) => b.items.length > 0).map((b) => (
            <details key={b.label} className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
              <summary className="cursor-pointer px-4 py-3">
                <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
                  {b.label}
                </span>
                <span className="ml-3 text-xs text-zinc-500">
                  {b.items.length} item{b.items.length === 1 ? "" : "s"} · {formatBdt(b.total)}
                </span>
              </summary>
              <table className="min-w-full divide-y divide-zinc-100 text-xs dark:divide-zinc-800">
                <thead className="bg-zinc-50 dark:bg-zinc-950">
                  <tr>
                    <th className="px-4 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Date</th>
                    <th className="px-4 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Voucher</th>
                    <th className="px-4 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Fund</th>
                    <th className="px-4 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Description</th>
                    <th className="px-4 py-2 text-right text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Original</th>
                    <th className="px-4 py-2 text-right text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Outstanding</th>
                    <th className="px-4 py-2 text-right text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Age (days)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {b.items.map((item) => {
                    const ageDays = Math.floor((asOf.getTime() - item.entryDate.getTime()) / 86400000);
                    return (
                      <tr key={item.id}>
                        <td className="px-4 py-1.5 whitespace-nowrap">{item.entryDate.toISOString().slice(0, 10)}</td>
                        <td className="px-4 py-1.5 font-mono text-[10px] text-zinc-500">{item.voucherNo ?? "—"}</td>
                        <td className="px-4 py-1.5 text-[10px]">{item.fundCode ?? "—"}</td>
                        <td className="px-4 py-1.5 text-zinc-600 dark:text-zinc-400">{item.description ?? "—"}</td>
                        <td className="px-4 py-1.5 text-right tabular-nums">{formatBdt(item.original)}</td>
                        <td className="px-4 py-1.5 text-right font-medium tabular-nums">{formatBdt(item.remaining)}</td>
                        <td className="px-4 py-1.5 text-right font-mono text-[10px]">{ageDays}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </details>
          ))}
        </section>

        <p className="mt-6 text-[11px] text-zinc-500">
          FIFO settlement: each debit on this account is an open receivable; each credit settles
          the oldest open items first. Investigate large 90+ day buckets — they're invoices the
          fund hasn't paid the AMC.
        </p>
      </div>
    </main>
  );
}
