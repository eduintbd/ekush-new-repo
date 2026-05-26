// /cash-flow — cash movement detail. For each journal line that hits a
// cash/bank account, look at the OTHER lines in the same batch (the
// counter-accounts) and bucket the cash move by counter-account category.
//
// This is NOT a full IAS-7 indirect-method cash flow statement (that
// requires period-over-period BS deltas, depreciation add-back, etc.).
// It's a "where did our cash come from / go to" detail report — the
// most useful single-period view for an AMC where cash is the dominant
// transaction medium.

import Link from "next/link";
import { requireStaff } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { formatBdt } from "@/lib/format";
import { PrintButton } from "@/components/print-button";

type Search = { fy?: string; from?: string; to?: string };

const CASH_NAME_PATTERN =
  /(cash|bank|brac|ucb|bkash|nagad|rocket|mtbl|dbbl|ebl|std account|dutch|eastern|premier|prime|nccb|ab bank|city bank|midland|sonali|janata|agrani|rupali)/i;

export const metadata = { title: "Cash Flow — Staff portal" };

export default async function CashFlowPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  await requireStaff();
  const sp = await searchParams;

  const fiscalYears = await prisma.fiscalYear
    .findMany({ orderBy: { startsOn: "desc" }, select: { id: true, label: true, startsOn: true, endsOn: true } })
    .catch(() => []);
  if (fiscalYears.length === 0) {
    return (
      <Shell>
        <p className="mt-10 text-sm text-zinc-500">No fiscal years. Seed the DB first.</p>
      </Shell>
    );
  }

  const fy = fiscalYears.find((y) => y.id === sp.fy) ?? fiscalYears[0];
  const fromDate = sp.from ? new Date(sp.from) : fy.startsOn;
  const toDate = sp.to ? new Date(sp.to) : fy.endsOn;

  // Identify cash/bank accounts.
  const cashAccounts = await prisma.chartOfAccount.findMany({
    where: {
      isActive: true,
      OR: [
        { category: { contains: "cash", mode: "insensitive" } },
        { category: { contains: "bank", mode: "insensitive" } },
        { name: { contains: "cash", mode: "insensitive" } },
        { name: { contains: "bank", mode: "insensitive" } },
        { name: { contains: "brac", mode: "insensitive" } },
        { name: { contains: "ucb", mode: "insensitive" } },
        { name: { contains: "bkash", mode: "insensitive" } },
        { name: { contains: "mtbl", mode: "insensitive" } },
        { name: { contains: "dbbl", mode: "insensitive" } },
        { name: { contains: "ebl", mode: "insensitive" } },
        { name: { contains: "std account", mode: "insensitive" } },
      ],
    },
  });
  const cashNames = new Set(
    cashAccounts
      .filter((a) => (a.category && /cash|bank/i.test(a.category)) || (a.normalBalance === "DEBIT" && CASH_NAME_PATTERN.test(a.name)))
      .map((a) => a.name),
  );

  if (cashNames.size === 0) {
    return (
      <Shell>
        <p className="mt-10 text-sm text-zinc-500">
          No cash/bank accounts detected. Tag accounts with category "Cash and bank balances".
        </p>
      </Shell>
    );
  }

  // Fetch all journal lines touching cash/bank accounts in the window
  // (these are the "cash side"), plus all lines from their batches (these
  // are the "counter side").
  const cashLines = await prisma.journal.findMany({
    where: {
      fiscalYearId: fy.id,
      accountName: { in: Array.from(cashNames) },
      entryDate: { gte: fromDate, lte: toDate },
    },
    select: { id: true, entryDate: true, batchId: true, accountName: true, debit: true, credit: true, description: true, fundCode: true },
    take: 5000,
  });

  const batchIds = Array.from(
    new Set(cashLines.map((c) => c.batchId).filter((b): b is string => !!b)),
  );
  const counterLines = batchIds.length
    ? await prisma.journal.findMany({
        where: { batchId: { in: batchIds }, accountName: { notIn: Array.from(cashNames) } },
        select: { batchId: true, accountName: true, debit: true, credit: true },
      })
    : [];
  // Map counter-account → category (for grouping)
  const allCounterAccounts = Array.from(new Set(counterLines.map((c) => c.accountName)));
  const counterCoa = allCounterAccounts.length
    ? await prisma.chartOfAccount.findMany({
        where: { name: { in: allCounterAccounts } },
        select: { name: true, category: true, normalBalance: true },
      })
    : [];
  const catMap = new Map(counterCoa.map((c) => [c.name, { category: c.category, normalBalance: c.normalBalance }]));

  // For each cash line, find the counter-line(s) in its batch and weight
  // the cash movement by each counter-line's share of the batch.
  const counterByBatch = new Map<string, { accountName: string; debit: number; credit: number }[]>();
  for (const cl of counterLines) {
    if (!cl.batchId) continue;
    const arr = counterByBatch.get(cl.batchId) ?? [];
    arr.push({ accountName: cl.accountName, debit: Number(cl.debit), credit: Number(cl.credit) });
    counterByBatch.set(cl.batchId, arr);
  }

  type Bucket = { inflow: number; outflow: number; lineCount: number; accounts: Map<string, { in: number; out: number }> };
  const buckets = new Map<string, Bucket>();
  const getBucket = (cat: string) => {
    let b = buckets.get(cat);
    if (!b) {
      b = { inflow: 0, outflow: 0, lineCount: 0, accounts: new Map() };
      buckets.set(cat, b);
    }
    return b;
  };

  let totalInflow = 0;
  let totalOutflow = 0;
  for (const cash of cashLines) {
    const d = Number(cash.debit);
    const c = Number(cash.credit);
    const net = d - c; // > 0 means cash IN (cash account debited), < 0 means cash OUT
    if (Math.abs(net) < 0.005) continue;
    if (net > 0) totalInflow += net;
    else totalOutflow += -net;

    const counters = (cash.batchId && counterByBatch.get(cash.batchId)) || [];
    const counterTotal = counters.reduce((s, x) => s + Math.abs(x.debit - x.credit), 0);
    if (counters.length === 0 || counterTotal < 0.005) {
      // No counterpart — bucket under "Uncategorised"
      const b = getBucket("Uncategorised");
      if (net > 0) b.inflow += net;
      else b.outflow += -net;
      b.lineCount += 1;
      continue;
    }
    for (const cp of counters) {
      const cpNet = Math.abs(cp.debit - cp.credit);
      if (cpNet < 0.005) continue;
      const share = cpNet / counterTotal;
      const cat = catMap.get(cp.accountName)?.category ?? "Uncategorised";
      const b = getBucket(cat);
      if (net > 0) b.inflow += net * share;
      else b.outflow += -net * share;
      b.lineCount += 1;
      let acc = b.accounts.get(cp.accountName);
      if (!acc) {
        acc = { in: 0, out: 0 };
        b.accounts.set(cp.accountName, acc);
      }
      if (net > 0) acc.in += net * share;
      else acc.out += -net * share;
    }
  }

  const sortedBuckets = Array.from(buckets.entries()).sort((a, b) => {
    const aMag = a[1].inflow + a[1].outflow;
    const bMag = b[1].inflow + b[1].outflow;
    return bMag - aMag;
  });

  const netChange = totalInflow - totalOutflow;

  return (
    <Shell>
      <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-widest text-zinc-500">Staff portal</p>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            Cash Flow (detail)
          </h1>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            Counter-account roll-up · {fromDate.toISOString().slice(0, 10)} → {toDate.toISOString().slice(0, 10)}
            {" · "}
            {cashNames.size} cash/bank account{cashNames.size === 1 ? "" : "s"}
            {" · "}
            {cashLines.length} cash-side line{cashLines.length === 1 ? "" : "s"}
          </p>
          <p className="mt-1 text-xs text-zinc-500">
            For the IAS 7 direct-method statement, see{" "}
            <Link
              href={`/cash-flow-statement?fy=${fy.id}&from=${fromDate.toISOString().slice(0, 10)}&to=${toDate.toISOString().slice(0, 10)}`}
              className="underline hover:text-zinc-700 dark:hover:text-zinc-300"
            >
              /cash-flow-statement
            </Link>
            .
          </p>
        </div>
        <form className="flex flex-wrap items-end gap-2 text-sm">
          <label className="block">
            <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
              Fiscal year
            </span>
            <select
              name="fy"
              defaultValue={fy.id}
              className="mt-1 block w-44 rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-900"
            >
              {fiscalYears.map((y) => (
                <option key={y.id} value={y.id}>{y.label}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">From</span>
            <input type="date" name="from" defaultValue={sp.from ?? fy.startsOn.toISOString().slice(0, 10)} className="mt-1 block rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-900" />
          </label>
          <label className="block">
            <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">To</span>
            <input type="date" name="to" defaultValue={sp.to ?? fy.endsOn.toISOString().slice(0, 10)} className="mt-1 block rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-900" />
          </label>
          <button className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">
            Apply
          </button>
          <PrintButton />
        </form>
      </div>

      {/* Summary tiles */}
      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Tile label="Total inflow" amount={totalInflow} kind="in" />
        <Tile label="Total outflow" amount={totalOutflow} kind="out" />
        <Tile label="Net change" amount={netChange} kind={netChange >= 0 ? "in" : "out"} highlight />
      </div>

      {sortedBuckets.length === 0 ? (
        <p className="mt-10 text-sm text-zinc-500">No cash activity in this window.</p>
      ) : (
        <div className="mt-6 space-y-4">
          {sortedBuckets.map(([cat, b]) => (
            <details key={cat} className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900" open>
              <summary className="cursor-pointer px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">{cat}</span>
                  <div className="flex items-center gap-3 text-xs">
                    <span className="text-emerald-700 dark:text-emerald-300">
                      + {formatBdt(b.inflow)}
                    </span>
                    <span className="text-red-700 dark:text-red-300">
                      − {formatBdt(b.outflow)}
                    </span>
                    <span className={`font-semibold ${b.inflow - b.outflow >= 0 ? "text-emerald-800 dark:text-emerald-200" : "text-red-800 dark:text-red-200"}`}>
                      = {formatBdt(Math.abs(b.inflow - b.outflow))}{" "}
                      {b.inflow - b.outflow >= 0 ? "in" : "out"}
                    </span>
                  </div>
                </div>
              </summary>
              <table className="min-w-full divide-y divide-zinc-100 text-xs dark:divide-zinc-800">
                <thead className="bg-zinc-50 dark:bg-zinc-950">
                  <tr>
                    <th className="px-4 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                      Counter-account
                    </th>
                    <th className="px-4 py-2 text-right text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                      Inflow
                    </th>
                    <th className="px-4 py-2 text-right text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                      Outflow
                    </th>
                    <th className="px-4 py-2 text-right text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                      Net
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {Array.from(b.accounts.entries())
                    .sort((x, y) => (y[1].in + y[1].out) - (x[1].in + x[1].out))
                    .map(([accName, totals]) => (
                      <tr key={accName} className="hover:bg-zinc-50 dark:hover:bg-zinc-950">
                        <td className="px-4 py-1.5">
                          <Link href={`/ledger/${encodeURIComponent(accName)}`} className="underline-offset-2 hover:underline">
                            {accName}
                          </Link>
                        </td>
                        <td className="px-4 py-1.5 text-right tabular-nums">
                          {totals.in > 0 ? formatBdt(totals.in) : "—"}
                        </td>
                        <td className="px-4 py-1.5 text-right tabular-nums">
                          {totals.out > 0 ? formatBdt(totals.out) : "—"}
                        </td>
                        <td className="px-4 py-1.5 text-right font-medium tabular-nums">
                          {formatBdt(Math.abs(totals.in - totals.out))}{" "}
                          {totals.in - totals.out >= 0 ? "in" : "out"}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </details>
          ))}
        </div>
      )}

      <p className="mt-6 text-[11px] text-zinc-500">
        Note: this is a counter-account categorisation, not a full IAS-7 cash-flow statement.
        Categories come from the <code>category</code> column on Chart of Accounts; accounts without
        a category appear under "Uncategorised". Set categories on{" "}
        <Link href="/admin/accounts" className="underline">/admin/accounts</Link> to improve grouping.
      </p>
    </Shell>
  );
}

function Tile({ label, amount, kind, highlight = false }: { label: string; amount: number; kind: "in" | "out"; highlight?: boolean }) {
  const color = kind === "in" ? "text-emerald-700 dark:text-emerald-300" : "text-red-700 dark:text-red-300";
  return (
    <div className={`rounded-lg border p-4 ${highlight ? "border-zinc-900 bg-zinc-50 dark:border-zinc-100 dark:bg-zinc-900" : "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"}`}>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">{label}</p>
      <p className={`mt-1 font-mono text-base tabular-nums ${color}`}>
        {kind === "in" ? "+ " : "− "}
        {formatBdt(Math.abs(amount))}
      </p>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10 dark:bg-zinc-950">
      <div className="mx-auto max-w-6xl">
        <Link href="/dashboard" className="text-xs uppercase tracking-widest text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
          ← Dashboard
        </Link>
        {children}
      </div>
    </main>
  );
}
