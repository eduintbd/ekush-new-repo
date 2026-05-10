// /journals — list journal lines for the selected fiscal year. Filter by
// account / txnType. Line-level view (each row is one debit or credit leg);
// shared batch_id groups compound entries.

import Link from "next/link";
import { requireStaff } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { formatBdt } from "@/lib/format";

type Search = { fy?: string; account?: string; txnType?: string };

export const metadata = { title: "Journals — Staff portal" };

export default async function JournalsPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  await requireStaff();
  const sp = await searchParams;

  const fiscalYears = await prisma.fiscalYear
    .findMany({ orderBy: { startsOn: "desc" }, select: { id: true, label: true } })
    .catch(() => []);

  const fyId = sp.fy ?? fiscalYears[0]?.id;
  const lines = fyId
    ? await prisma.journal
        .findMany({
          where: {
            fiscalYearId: fyId,
            accountName: sp.account ?? undefined,
            txnType: sp.txnType ?? undefined,
          },
          orderBy: [{ entryDate: "desc" }, { batchId: "asc" }, { createdAt: "asc" }],
          take: 200,
        })
        .catch(() => [])
    : [];

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10 dark:bg-zinc-950">
      <div className="mx-auto max-w-6xl">
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-widest text-zinc-500">Staff portal</p>
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
              Journals
            </h1>
          </div>
          <Link
            href="/journals/new"
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900"
          >
            + New entry
          </Link>
        </div>

        <form className="mt-6 flex flex-wrap gap-2 text-sm">
          <select
            name="fy"
            defaultValue={fyId ?? ""}
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 dark:border-zinc-700 dark:bg-zinc-900"
          >
            {fiscalYears.length === 0 && <option value="">No fiscal years</option>}
            {fiscalYears.map((y) => (
              <option key={y.id} value={y.id}>
                {y.label}
              </option>
            ))}
          </select>
          <input
            name="account"
            placeholder="account name"
            defaultValue={sp.account}
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 dark:border-zinc-700 dark:bg-zinc-900"
          />
          <input
            name="txnType"
            placeholder="txnType"
            defaultValue={sp.txnType}
            className="w-24 rounded-md border border-zinc-300 bg-white px-3 py-1.5 dark:border-zinc-700 dark:bg-zinc-900"
          />
          <button className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">
            Filter
          </button>
        </form>

        {fiscalYears.length === 0 ? (
          <p className="mt-10 text-sm text-zinc-500">
            No fiscal years yet. Run <code>npm run db:seed</code> to create FY2025-26.
          </p>
        ) : lines.length === 0 ? (
          <p className="mt-10 text-sm text-zinc-500">No journal lines for this filter.</p>
        ) : (
          <div className="mt-6 overflow-x-auto rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
              <thead className="bg-zinc-50 dark:bg-zinc-950">
                <tr>
                  <Th>Date</Th>
                  <Th>Type</Th>
                  <Th>Account</Th>
                  <Th>Description</Th>
                  <Th align="right">Debit</Th>
                  <Th align="right">Credit</Th>
                  <Th>Batch</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {lines.map((j) => (
                  <tr key={j.id}>
                    <Td>{j.entryDate.toISOString().slice(0, 10)}</Td>
                    <Td>
                      <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-zinc-600 dark:bg-zinc-800">
                        {j.txnType ?? "j"}
                      </span>
                    </Td>
                    <Td>{j.accountName}</Td>
                    <Td className="text-zinc-600 dark:text-zinc-400">{j.description ?? "—"}</Td>
                    <Td align="right">{Number(j.debit) > 0 ? formatBdt(Number(j.debit)) : "—"}</Td>
                    <Td align="right">{Number(j.credit) > 0 ? formatBdt(Number(j.credit)) : "—"}</Td>
                    <Td className="font-mono text-[10px] text-zinc-500">
                      {j.batchId ? j.batchId.slice(0, 8) : "—"}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}

function Th({
  children,
  align = "left",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  const a = align === "right" ? "text-right" : "text-left";
  return (
    <th className={`${a} px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500`}>
      {children}
    </th>
  );
}

function Td({
  children,
  align = "left",
  className = "",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
  className?: string;
}) {
  const a = align === "right" ? "text-right tabular-nums" : "text-left";
  return <td className={`${a} px-4 py-2 ${className}`}>{children}</td>;
}
