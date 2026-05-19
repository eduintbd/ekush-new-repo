// /day-book — chronological listing of every voucher in a date range, with
// each compound entry rendered as one block (voucher header + line table).
// Default window: the latest month with activity.

import Link from "next/link";
import { requireStaff, canEdit } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { formatBdt } from "@/lib/format";
import { PrintButton } from "@/components/print-button";
import { DeleteVoucherForm } from "./delete-voucher-form";

type Search = { fy?: string; from?: string; to?: string };

export const metadata = { title: "Day Book — Staff portal" };

export default async function DayBookPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const profile = await requireStaff();
  const editable = canEdit(profile);
  const sp = await searchParams;

  const fiscalYears = await prisma.fiscalYear
    .findMany({ orderBy: { startsOn: "desc" }, select: { id: true, label: true, startsOn: true, endsOn: true } })
    .catch(() => []);

  if (fiscalYears.length === 0) {
    return (
      <main className="min-h-screen bg-zinc-50 px-6 py-10 dark:bg-zinc-950">
        <div className="mx-auto max-w-6xl">
          <Crumb />
          <p className="mt-10 text-sm text-zinc-500">No fiscal years. Seed the DB first.</p>
        </div>
      </main>
    );
  }

  const fy = fiscalYears.find((y) => y.id === sp.fy) ?? fiscalYears[0];
  const fyClosed = await prisma.fiscalYear
    .findUnique({ where: { id: fy.id }, select: { isClosed: true } })
    .then((r) => Boolean(r?.isClosed))
    .catch(() => false);
  const canMutate = editable && !fyClosed;

  // Default range: the latest month containing activity. If no `from`/`to`
  // are supplied, find the most recent entry_date and use that month.
  let fromDate: Date;
  let toDate: Date;
  if (sp.from || sp.to) {
    fromDate = sp.from ? new Date(sp.from) : fy.startsOn;
    toDate = sp.to ? new Date(sp.to) : fy.endsOn;
  } else {
    const last = await prisma.journal.findFirst({
      where: { fiscalYearId: fy.id },
      orderBy: { entryDate: "desc" },
      select: { entryDate: true },
    });
    if (last) {
      const d = last.entryDate;
      fromDate = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
      toDate = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
    } else {
      fromDate = fy.startsOn;
      toDate = fy.endsOn;
    }
  }

  const lines = await prisma.journal
    .findMany({
      where: {
        fiscalYearId: fy.id,
        entryDate: { gte: fromDate, lte: toDate },
      },
      orderBy: [{ entryDate: "asc" }, { voucherNo: "asc" }, { createdAt: "asc" }],
      take: 5000,
    })
    .catch(() => []);

  // Group lines by date → batch
  type Line = (typeof lines)[number];
  type Batch = {
    batchId: string | null;
    voucherNo: string | null;
    txnType: string | null;
    description: string | null;
    fundCode: string | null;
    lines: Line[];
    debit: number;
    credit: number;
  };
  type Day = { date: string; batches: Batch[]; debit: number; credit: number; voucherCount: number };

  const dayMap = new Map<string, Day>();
  for (const l of lines) {
    const dateKey = l.entryDate.toISOString().slice(0, 10);
    let day = dayMap.get(dateKey);
    if (!day) {
      day = { date: dateKey, batches: [], debit: 0, credit: 0, voucherCount: 0 };
      dayMap.set(dateKey, day);
    }
    const key = l.batchId ?? `solo:${l.id}`;
    let batch = day.batches.find((b) => (b.batchId ?? `solo:${l.id}`) === key);
    if (!batch) {
      batch = {
        batchId: l.batchId,
        voucherNo: l.voucherNo,
        txnType: l.txnType,
        description: l.description,
        fundCode: l.fundCode,
        lines: [],
        debit: 0,
        credit: 0,
      };
      day.batches.push(batch);
      day.voucherCount++;
    }
    batch.lines.push(l);
    batch.debit += Number(l.debit);
    batch.credit += Number(l.credit);
    day.debit += Number(l.debit);
    day.credit += Number(l.credit);
  }

  const days = Array.from(dayMap.values()).sort((a, b) => (a.date < b.date ? -1 : 1));
  const totalDebit = days.reduce((s, d) => s + d.debit, 0);
  const totalCredit = days.reduce((s, d) => s + d.credit, 0);
  const totalVouchers = days.reduce((s, d) => s + d.voucherCount, 0);

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10 dark:bg-zinc-950">
      <div className="mx-auto max-w-6xl">
        <Crumb />
        <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-widest text-zinc-500">Staff portal</p>
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
              Day Book
            </h1>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              {fromDate.toISOString().slice(0, 10)} → {toDate.toISOString().slice(0, 10)}
              {" · "}
              {totalVouchers} voucher{totalVouchers === 1 ? "" : "s"}
              {" · Σ debit "}
              {formatBdt(totalDebit)}
              {" · Σ credit "}
              {formatBdt(totalCredit)}
            </p>
          </div>
        </div>

        <form className="mt-6 flex flex-wrap items-end gap-2 text-sm">
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
                <option key={y.id} value={y.id}>
                  {y.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">From</span>
            <input
              type="date"
              name="from"
              defaultValue={fromDate.toISOString().slice(0, 10)}
              className="mt-1 block rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
          <label className="block">
            <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">To</span>
            <input
              type="date"
              name="to"
              defaultValue={toDate.toISOString().slice(0, 10)}
              className="mt-1 block rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
          <button className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">
            Apply
          </button>
          <PrintButton />
        </form>

        {days.length === 0 ? (
          <p className="mt-10 text-sm text-zinc-500">No vouchers in this window.</p>
        ) : (
          <div className="mt-6 space-y-8">
            {days.map((day) => (
              <DayBlock key={day.date} day={day} canMutate={canMutate} />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

function DayBlock({ day, canMutate }: { day: { date: string; batches: { batchId: string | null; voucherNo: string | null; txnType: string | null; description: string | null; fundCode: string | null; lines: { id: string; accountName: string; debit: unknown; credit: unknown }[]; debit: number; credit: number }[]; debit: number; credit: number; voucherCount: number }; canMutate: boolean }) {
  return (
    <section>
      <header className="flex items-end justify-between border-b border-zinc-200 pb-2 dark:border-zinc-800">
        <div>
          <p className="text-xs uppercase tracking-widest text-zinc-500">Date</p>
          <h2 className="font-mono text-lg font-semibold text-zinc-900 dark:text-zinc-50">{day.date}</h2>
        </div>
        <p className="text-xs text-zinc-500">
          {day.voucherCount} voucher{day.voucherCount === 1 ? "" : "s"}
          {" · Σ debit "}
          {formatBdt(day.debit)}
          {" · Σ credit "}
          {formatBdt(day.credit)}
        </p>
      </header>
      <div className="mt-3 space-y-3">
        {day.batches.map((b, i) => (
          <article
            key={(b.batchId ?? "solo") + i}
            className="overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
          >
            <header className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-100 bg-zinc-50 px-4 py-2 dark:border-zinc-800 dark:bg-zinc-950">
              <div className="flex items-center gap-3 text-xs">
                {b.batchId ? (
                  <Link href={`/journals/voucher/${b.batchId}`} className="font-mono font-medium text-zinc-700 underline-offset-2 hover:underline dark:text-zinc-300">
                    {b.voucherNo ?? "(unassigned)"}
                  </Link>
                ) : (
                  <span className="font-mono font-medium text-zinc-700 dark:text-zinc-300">
                    {b.voucherNo ?? "(unassigned)"}
                  </span>
                )}
                <span className="rounded bg-zinc-200 px-1.5 py-0.5 text-[10px] font-medium uppercase text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                  {b.txnType ?? "j"}
                </span>
                {b.fundCode && (
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-amber-800 dark:bg-amber-950 dark:text-amber-200">
                    {b.fundCode}
                  </span>
                )}
                <span className="text-zinc-600 dark:text-zinc-400">{b.description ?? "—"}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="font-mono text-[10px] text-zinc-500">
                  {formatBdt(b.debit)} / {formatBdt(b.credit)}
                </span>
                {canMutate && b.batchId && (
                  <div className="no-print flex items-center gap-1">
                    <Link
                      href={`/journals/voucher/${b.batchId}/edit`}
                      className="rounded border border-zinc-300 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                    >
                      Edit
                    </Link>
                    <DeleteVoucherForm batchId={b.batchId} voucherNo={b.voucherNo} />
                  </div>
                )}
              </div>
            </header>
            <table className="min-w-full divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {b.lines.map((l) => (
                  <tr key={l.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-950">
                    <td className="w-1/2 px-4 py-1.5">
                      <Link
                        href={`/ledger/${encodeURIComponent(l.accountName)}`}
                        className="text-sm underline-offset-2 hover:underline"
                      >
                        {l.accountName}
                      </Link>
                    </td>
                    <td className="px-4 py-1.5 text-right tabular-nums">
                      {Number(l.debit) > 0 ? formatBdt(Number(l.debit)) : ""}
                    </td>
                    <td className="px-4 py-1.5 text-right tabular-nums">
                      {Number(l.credit) > 0 ? formatBdt(Number(l.credit)) : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </article>
        ))}
      </div>
    </section>
  );
}

function Crumb() {
  return (
    <Link
      href="/dashboard"
      className="text-xs uppercase tracking-widest text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
    >
      ← Dashboard
    </Link>
  );
}
