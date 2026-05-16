// /bank-reconciliation/[id] — detail view of one recorded statement, with
// the book activity in the same period side-by-side for comparison.

import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaff } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { formatBdt } from "@/lib/format";
import { deleteBankStatement } from "../actions";

export const metadata = { title: "Statement detail — BRS" };

export default async function BRSDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireStaff();
  const { id } = await params;

  const stmt = await prisma.bankStatement.findUnique({
    where: { id },
    include: { fiscalYear: { select: { label: true } } },
  });
  if (!stmt) notFound();

  const [openingAgg, periodAgg, periodLines] = await Promise.all([
    prisma.journal.aggregate({
      where: { accountName: stmt.accountName, entryDate: { lt: stmt.periodStart } },
      _sum: { debit: true, credit: true },
    }),
    prisma.journal.aggregate({
      where: {
        accountName: stmt.accountName,
        entryDate: { gte: stmt.periodStart, lte: stmt.periodEnd },
      },
      _sum: { debit: true, credit: true },
    }),
    prisma.journal.findMany({
      where: {
        accountName: stmt.accountName,
        entryDate: { gte: stmt.periodStart, lte: stmt.periodEnd },
      },
      orderBy: [{ entryDate: "asc" }, { createdAt: "asc" }],
      take: 500,
    }),
  ]);

  const bookOpening = Number(openingAgg._sum.debit ?? 0) - Number(openingAgg._sum.credit ?? 0);
  const bookPeriodDebit = Number(periodAgg._sum.debit ?? 0);
  const bookPeriodCredit = Number(periodAgg._sum.credit ?? 0);
  const bookClosing = bookOpening + bookPeriodDebit - bookPeriodCredit;

  const stmtOpening = Number(stmt.openingBalance);
  const stmtClosing = Number(stmt.closingBalance);
  const openingDiff = stmtOpening - bookOpening;
  const closingDiff = stmtClosing - bookClosing;
  const inBalance = Math.abs(closingDiff) < 1;

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10 dark:bg-zinc-950">
      <div className="mx-auto max-w-5xl">
        <div className="text-xs uppercase tracking-widest text-zinc-500">
          <Link href="/dashboard" className="hover:text-zinc-700 dark:hover:text-zinc-300">← Dashboard</Link>
          <span className="mx-1.5 text-zinc-400">/</span>
          <Link href="/bank-reconciliation" className="hover:text-zinc-700 dark:hover:text-zinc-300">Bank Reconciliation</Link>
        </div>

        <div className="mt-3 flex items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
              <Link href={`/ledger/${encodeURIComponent(stmt.accountName)}`} className="underline-offset-2 hover:underline">
                {stmt.accountName}
              </Link>
            </h1>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              {stmt.fiscalYear.label} · {stmt.periodStart.toISOString().slice(0, 10)} →{" "}
              {stmt.periodEnd.toISOString().slice(0, 10)}
              {stmt.sourceFile && (
                <> · <span className="font-mono text-xs">{stmt.sourceFile}</span></>
              )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {inBalance ? (
              <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                ✓ Reconciled
              </span>
            ) : (
              <span className="rounded-full bg-red-100 px-3 py-1 text-xs font-medium text-red-700 dark:bg-red-950 dark:text-red-300">
                ✗ Difference {formatBdt(closingDiff)}
              </span>
            )}
            <form action={deleteBankStatement}>
              <input type="hidden" name="id" value={stmt.id} />
              <button
                type="submit"
                className="rounded-md border border-red-300 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950"
              >
                Delete
              </button>
            </form>
          </div>
        </div>

        {/* BRS comparison panel */}
        <div className="mt-6 overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
            <thead className="bg-zinc-50 dark:bg-zinc-950">
              <tr>
                <th className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                  Line
                </th>
                <th className="px-4 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                  Per statement
                </th>
                <th className="px-4 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                  Per books
                </th>
                <th className="px-4 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                  Difference
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              <Row label="Opening balance" stmt={stmtOpening} book={bookOpening} />
              <Row label={`+ Period debits (deposits)`} stmt={null} book={bookPeriodDebit} />
              <Row label={`− Period credits (withdrawals)`} stmt={null} book={bookPeriodCredit} />
              <tr className="bg-zinc-50 font-semibold dark:bg-zinc-950">
                <td className="px-4 py-2">Closing balance</td>
                <td className="px-4 py-2 text-right font-mono tabular-nums">{formatBdt(stmtClosing)}</td>
                <td className="px-4 py-2 text-right font-mono tabular-nums">{formatBdt(bookClosing)}</td>
                <td className={`px-4 py-2 text-right font-mono tabular-nums ${inBalance ? "" : "text-red-700 dark:text-red-300"}`}>
                  {Math.abs(closingDiff) < 0.005 ? "—" : formatBdt(closingDiff)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        {!inBalance && (
          <p className="mt-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
            The closing balances differ by <strong>{formatBdt(closingDiff)}</strong>.
            {Math.abs(openingDiff) > 0.5 && (
              <> Opening already off by <strong>{formatBdt(openingDiff)}</strong> — fix prior-period reconciliation first.</>
            )}
            {" "}Per-line clearing (matching individual journal lines to bank lines) is Tier 3; for now, drill into the ledger card to investigate.
          </p>
        )}

        {/* Period activity drill */}
        <div className="mt-8">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">
            Period activity ({periodLines.length} line{periodLines.length === 1 ? "" : "s"})
          </h2>
          {periodLines.length === 0 ? (
            <p className="mt-3 text-sm text-zinc-500">No activity in this window.</p>
          ) : (
            <div className="mt-3 overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
              <table className="min-w-full divide-y divide-zinc-100 text-xs dark:divide-zinc-800">
                <thead className="bg-zinc-50 dark:bg-zinc-950">
                  <tr>
                    <th className="px-4 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Date</th>
                    <th className="px-4 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Voucher</th>
                    <th className="px-4 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Description</th>
                    <th className="px-4 py-2 text-right text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Debit</th>
                    <th className="px-4 py-2 text-right text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Credit</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {periodLines.map((j) => (
                    <tr key={j.id}>
                      <td className="px-4 py-1.5 whitespace-nowrap">{j.entryDate.toISOString().slice(0, 10)}</td>
                      <td className="px-4 py-1.5 font-mono text-[10px] text-zinc-500">{j.voucherNo ?? "—"}</td>
                      <td className="px-4 py-1.5 text-zinc-600 dark:text-zinc-400">{j.description ?? "—"}</td>
                      <td className="px-4 py-1.5 text-right tabular-nums">{Number(j.debit) > 0 ? formatBdt(Number(j.debit)) : "—"}</td>
                      <td className="px-4 py-1.5 text-right tabular-nums">{Number(j.credit) > 0 ? formatBdt(Number(j.credit)) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {stmt.notes && (
          <p className="mt-6 rounded-md border border-zinc-200 bg-white px-3 py-2 text-xs text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
            <strong>Notes:</strong> {stmt.notes}
          </p>
        )}
      </div>
    </main>
  );
}

function Row({ label, stmt, book }: { label: string; stmt: number | null; book: number }) {
  return (
    <tr>
      <td className="px-4 py-2">{label}</td>
      <td className="px-4 py-2 text-right font-mono tabular-nums text-zinc-500">
        {stmt == null ? "—" : formatBdt(stmt)}
      </td>
      <td className="px-4 py-2 text-right font-mono tabular-nums">{formatBdt(book)}</td>
      <td className="px-4 py-2 text-right font-mono tabular-nums text-zinc-400">
        {stmt == null ? "—" : formatBdt(stmt - book)}
      </td>
    </tr>
  );
}
