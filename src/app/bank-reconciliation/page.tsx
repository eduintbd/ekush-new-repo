// /bank-reconciliation — list of all imported/recorded bank statements
// with per-statement BRS status (in-balance vs out-of-balance).

import Link from "next/link";
import { requireStaff } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { formatBdt } from "@/lib/format";

export const metadata = { title: "Bank Reconciliation — Staff portal" };

export default async function BRSListPage() {
  await requireStaff();

  const statements = await prisma.bankStatement
    .findMany({
      include: { fiscalYear: { select: { label: true } } },
      orderBy: [{ accountName: "asc" }, { periodEnd: "desc" }],
    })
    .catch(() => []);

  // Compute book balance per statement
  const bookBalances = new Map<string, number>();
  for (const s of statements) {
    const agg = await prisma.journal.aggregate({
      where: {
        accountName: s.accountName,
        entryDate: { lte: s.periodEnd },
      },
      _sum: { debit: true, credit: true },
    });
    const balance = Number(agg._sum.debit ?? 0) - Number(agg._sum.credit ?? 0);
    bookBalances.set(s.id, balance);
  }

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10 dark:bg-zinc-950">
      <div className="mx-auto max-w-6xl">
        <Link href="/dashboard" className="text-xs uppercase tracking-widest text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
          ← Dashboard
        </Link>
        <div className="mt-3 flex items-end justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-widest text-zinc-500">Staff portal</p>
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
              Bank Reconciliation
            </h1>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              {statements.length} recorded statement{statements.length === 1 ? "" : "s"}. Per-line
              clearance is Tier 3; this page does a book-vs-statement balance comparison.
            </p>
          </div>
          <Link
            href="/bank-reconciliation/new"
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
          >
            + Record statement
          </Link>
        </div>

        {statements.length === 0 ? (
          <p className="mt-10 text-sm text-zinc-500">
            No bank statements recorded yet. Click <em>Record statement</em> to enter your first
            BRS — pick the bank account, the statement period, and the statement opening + closing
            balance from the bank's PDF/letter.
          </p>
        ) : (
          <div className="mt-6 overflow-x-auto rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
              <thead className="bg-zinc-50 dark:bg-zinc-950">
                <tr>
                  <Th>Account</Th>
                  <Th>FY</Th>
                  <Th>Period</Th>
                  <Th align="right">Statement closing</Th>
                  <Th align="right">Book closing</Th>
                  <Th align="right">Diff</Th>
                  <Th>Status</Th>
                  <Th />
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {statements.map((s) => {
                  const book = bookBalances.get(s.id) ?? 0;
                  const stmt = Number(s.closingBalance);
                  const diff = stmt - book;
                  const inBalance = Math.abs(diff) < 1;
                  return (
                    <tr key={s.id}>
                      <Td className="font-medium">
                        <Link href={`/ledger/${encodeURIComponent(s.accountName)}`} className="underline-offset-2 hover:underline">
                          {s.accountName}
                        </Link>
                      </Td>
                      <Td className="text-xs">{s.fiscalYear.label}</Td>
                      <Td className="text-xs">
                        {s.periodStart.toISOString().slice(0, 10)} → {s.periodEnd.toISOString().slice(0, 10)}
                      </Td>
                      <Td align="right">{formatBdt(stmt)}</Td>
                      <Td align="right">{formatBdt(book)}</Td>
                      <Td align="right" className={inBalance ? "" : "font-semibold text-red-700 dark:text-red-300"}>
                        {Math.abs(diff) < 0.005 ? "—" : formatBdt(diff)}
                      </Td>
                      <Td>
                        {inBalance ? (
                          <span className="inline-flex rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium uppercase text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                            ✓ matched
                          </span>
                        ) : (
                          <span className="inline-flex rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-medium uppercase text-red-700 dark:bg-red-950 dark:text-red-300">
                            ✗ off
                          </span>
                        )}
                      </Td>
                      <Td>
                        <Link href={`/bank-reconciliation/${s.id}`} className="text-xs underline">
                          open →
                        </Link>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}

function Th({ children, align = "left" }: { children?: React.ReactNode; align?: "left" | "right" }) {
  const a = align === "right" ? "text-right" : "text-left";
  return <th className={`${a} px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500`}>{children}</th>;
}

function Td({ children, align = "left", className = "" }: { children?: React.ReactNode; align?: "left" | "right"; className?: string }) {
  const a = align === "right" ? "text-right tabular-nums" : "text-left";
  return <td className={`${a} px-4 py-2 ${className}`}>{children}</td>;
}
