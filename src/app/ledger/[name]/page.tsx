// /ledger/[name] — per-account ledger card with running balance, in the
// Tally tradition. Account name is URL-encoded in the path segment.
//
// Default view: all activity for selected fiscal year, ascending date.
// Date range optional via ?from=&to=. The fiscal-year picker scopes
// the underlying query (journals are stored against fiscalYearId).

import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaff } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { formatBdt } from "@/lib/format";
import { PrintButton } from "@/components/print-button";

type Search = { fy?: string; from?: string; to?: string; instrument?: string };

export const metadata = { title: "Ledger card — Staff portal" };

export default async function LedgerPage({
  params,
  searchParams,
}: {
  params: Promise<{ name: string }>;
  searchParams: Promise<Search>;
}) {
  await requireStaff();
  const { name: rawName } = await params;
  const accountName = decodeURIComponent(rawName);
  const sp = await searchParams;

  const account = await prisma.chartOfAccount.findUnique({
    where: { name: accountName },
  });
  if (!account) notFound();

  const fiscalYears = await prisma.fiscalYear
    .findMany({ orderBy: { startsOn: "desc" }, select: { id: true, label: true, startsOn: true, endsOn: true } })
    .catch(() => []);

  if (fiscalYears.length === 0) {
    return (
      <main className="min-h-screen bg-zinc-50 px-6 py-10 dark:bg-zinc-950">
        <div className="mx-auto max-w-6xl">
          <Breadcrumb account={account.name} />
          <p className="mt-10 text-sm text-zinc-500">No fiscal years. Seed the DB first.</p>
        </div>
      </main>
    );
  }

  const fy = fiscalYears.find((y) => y.id === sp.fy) ?? fiscalYears[0];
  const fromDate = sp.from ? new Date(sp.from) : null;
  const toDate = sp.to ? new Date(sp.to) : null;
  const instrumentFilter = sp.instrument && sp.instrument.length > 0 ? sp.instrument : null;

  // Opening balance: sum of activity on this account BEFORE the selected
  // window. Window starts at `from` if given, else at fy.startsOn. We pull
  // across ALL fiscal years so historical opening is preserved when the
  // user date-filters into the middle of a year. When an instrument
  // filter is active, opening must also be scoped to that instrument —
  // otherwise the running balance is meaningless.
  const openingCutoff = fromDate ?? fy.startsOn;
  const opening = await prisma.journal
    .aggregate({
      where: {
        accountName: account.name,
        entryDate: { lt: openingCutoff },
        ...(instrumentFilter ? { instrumentCode: instrumentFilter } : {}),
      },
      _sum: { debit: true, credit: true },
    })
    .catch(() => ({ _sum: { debit: 0, credit: 0 } }));
  const openingDebit = Number(opening._sum.debit ?? 0);
  const openingCredit = Number(opening._sum.credit ?? 0);
  const openingBalance = openingDebit - openingCredit; // signed: + = Dr, − = Cr

  // Period activity, ordered chronologically for running-balance accumulation.
  // Always floor the period at `openingCutoff` (= user's `from` if given,
  // else fy.startsOn) so OB rows — which live inside the FY but predate
  // its startsOn (2025-06-30 vs 2025-07-01) — aren't double-counted: once
  // in the opening aggregate above, and again in this period list.
  const lines = await prisma.journal
    .findMany({
      where: {
        accountName: account.name,
        fiscalYearId: fy.id,
        entryDate: {
          gte: openingCutoff,
          ...(toDate ? { lte: toDate } : {}),
        },
        ...(instrumentFilter ? { instrumentCode: instrumentFilter } : {}),
      },
      orderBy: [{ entryDate: "asc" }, { voucherNo: "asc" }, { createdAt: "asc" }],
      take: 1000,
    })
    .catch(() => []);

  let running = openingBalance;
  const rows = lines.map((j) => {
    running += Number(j.debit) - Number(j.credit);
    return { j, running };
  });

  const periodDebit = lines.reduce((s, j) => s + Number(j.debit), 0);
  const periodCredit = lines.reduce((s, j) => s + Number(j.credit), 0);
  const closingBalance = openingBalance + periodDebit - periodCredit;

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10 dark:bg-zinc-950">
      <div className="mx-auto max-w-7xl">
        <Breadcrumb account={account.name} />

        <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-widest text-zinc-500">Ledger card</p>
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
              {account.name}
            </h1>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              <NormalBadge nb={account.normalBalance} />
              {account.category && (
                <span className="ml-2 text-xs text-zinc-500">{account.category}</span>
              )}
              {!account.isActive && (
                <span className="ml-2 rounded bg-zinc-200 px-1.5 py-0.5 text-[10px] font-medium uppercase text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                  inactive
                </span>
              )}
              {instrumentFilter && (
                <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-medium uppercase text-sky-800 dark:bg-sky-950 dark:text-sky-200">
                  Filtered: <span className="font-mono">{instrumentFilter}</span>
                </span>
              )}
            </p>
          </div>
          <div className="no-print flex items-center gap-2">
            <a
              href={`/api/exports/csv/ledger/${encodeURIComponent(account.name)}?fy=${fy.id}${sp.from ? `&from=${sp.from}` : ""}${sp.to ? `&to=${sp.to}` : ""}${instrumentFilter ? `&instrument=${encodeURIComponent(instrumentFilter)}` : ""}`}
              className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              ⬇ CSV
            </a>
            <PrintButton />
            <Link
              href={`/admin/accounts/${account.id}`}
              className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              Edit account →
            </Link>
          </div>
        </div>

        {/* Filters */}
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
              defaultValue={sp.from}
              className="mt-1 block rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
          <label className="block">
            <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">To</span>
            <input
              type="date"
              name="to"
              defaultValue={sp.to}
              className="mt-1 block rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
          <label className="block">
            <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">Instrument</span>
            <input
              type="text"
              name="instrument"
              defaultValue={sp.instrument ?? ""}
              placeholder="e.g. BANKASIA"
              className="mt-1 block w-32 rounded-md border border-zinc-300 bg-white px-2 py-1.5 font-mono text-xs normal-case dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
          <button className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">
            Apply
          </button>
          {(sp.from || sp.to) && (
            <Link
              href={`/ledger/${encodeURIComponent(account.name)}?fy=${fy.id}${instrumentFilter ? `&instrument=${encodeURIComponent(instrumentFilter)}` : ""}`}
              className="text-xs text-zinc-500 underline hover:text-zinc-700 dark:hover:text-zinc-300"
            >
              Clear range
            </Link>
          )}
          {instrumentFilter && (
            <Link
              href={`/ledger/${encodeURIComponent(account.name)}?fy=${fy.id}${sp.from ? `&from=${sp.from}` : ""}${sp.to ? `&to=${sp.to}` : ""}`}
              className="text-xs text-zinc-500 underline hover:text-zinc-700 dark:hover:text-zinc-300"
            >
              Clear instrument
            </Link>
          )}
        </form>

        {/* Summary tiles */}
        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Tile label="Opening balance" amount={openingBalance} hint={`as at ${openingCutoff.toISOString().slice(0, 10)}`} />
          <Tile label="Period debit" amount={periodDebit} forceDr />
          <Tile label="Period credit" amount={periodCredit} forceCr />
          <Tile label="Closing balance" amount={closingBalance} hint={`${lines.length} line${lines.length === 1 ? "" : "s"}`} highlight />
        </div>

        {/* Transactions */}
        {lines.length === 0 ? (
          <p className="mt-10 text-sm text-zinc-500">No activity in this window.</p>
        ) : (
          <div className="mt-6 overflow-x-auto rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
              <thead className="bg-zinc-50 dark:bg-zinc-950">
                <tr>
                  <Th>Date</Th>
                  <Th>Voucher#</Th>
                  <Th>Type</Th>
                  <Th>Description / Particulars</Th>
                  <Th>Fund</Th>
                  <Th>Instrument</Th>
                  <Th>Challan #</Th>
                  <Th align="right">Debit</Th>
                  <Th align="right">Credit</Th>
                  <Th align="right">Running balance</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                <tr className="bg-zinc-50 italic text-zinc-500 dark:bg-zinc-950">
                  <Td colSpan={9}>Opening balance as at {openingCutoff.toISOString().slice(0, 10)}</Td>
                  <Td align="right">{drCr(openingBalance)}</Td>
                </tr>
                {rows.map(({ j, running }) => (
                  <tr key={j.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-950">
                    <Td className="whitespace-nowrap">{j.entryDate.toISOString().slice(0, 10)}</Td>
                    <Td className="font-mono text-xs text-zinc-600 dark:text-zinc-400">
                      {j.voucherNo ?? "—"}
                    </Td>
                    <Td>
                      <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-zinc-600 dark:bg-zinc-800">
                        {j.txnType ?? "j"}
                      </span>
                    </Td>
                    <Td className="text-zinc-600 dark:text-zinc-400">{j.description ?? "—"}</Td>
                    <Td className="text-xs text-zinc-500">{j.fundCode ?? "—"}</Td>
                    <Td className="font-mono text-xs text-zinc-600 dark:text-zinc-400">{j.instrumentCode ?? "—"}</Td>
                    <Td className="font-mono text-xs text-zinc-600 dark:text-zinc-400">{j.challanNo ?? "—"}</Td>
                    <Td align="right">{Number(j.debit) > 0 ? formatBdt(Number(j.debit)) : "—"}</Td>
                    <Td align="right">{Number(j.credit) > 0 ? formatBdt(Number(j.credit)) : "—"}</Td>
                    <Td align="right" className="font-medium">{drCr(running)}</Td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-zinc-50 dark:bg-zinc-950">
                <tr className="font-semibold">
                  <Td colSpan={7}>Period totals</Td>
                  <Td align="right">{formatBdt(periodDebit)}</Td>
                  <Td align="right">{formatBdt(periodCredit)}</Td>
                  <Td align="right">{drCr(closingBalance)}</Td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}

function drCr(amount: number): string {
  if (Math.abs(amount) < 0.005) return "—";
  return `${formatBdt(Math.abs(amount))} ${amount > 0 ? "Dr" : "Cr"}`;
}

function Tile({
  label,
  amount,
  hint,
  highlight = false,
  forceDr = false,
  forceCr = false,
}: {
  label: string;
  amount: number;
  hint?: string;
  highlight?: boolean;
  forceDr?: boolean;
  forceCr?: boolean;
}) {
  const display = forceDr
    ? Math.abs(amount) < 0.005
      ? "—"
      : `${formatBdt(Math.abs(amount))} Dr`
    : forceCr
      ? Math.abs(amount) < 0.005
        ? "—"
        : `${formatBdt(Math.abs(amount))} Cr`
      : drCr(amount);
  return (
    <div
      className={`rounded-lg border p-4 ${
        highlight
          ? "border-zinc-900 bg-zinc-50 dark:border-zinc-100 dark:bg-zinc-900"
          : "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"
      }`}
    >
      <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">{label}</p>
      <p className="mt-1 font-mono text-base tabular-nums text-zinc-900 dark:text-zinc-50">{display}</p>
      {hint && <p className="mt-0.5 text-[10px] text-zinc-500">{hint}</p>}
    </div>
  );
}

function NormalBadge({ nb }: { nb: string }) {
  const cls =
    nb === "DEBIT"
      ? "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200"
      : "bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-200";
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${cls}`}
    >
      {nb} normal
    </span>
  );
}

function Breadcrumb({ account }: { account: string }) {
  return (
    <div className="text-xs uppercase tracking-widest text-zinc-500">
      <Link href="/dashboard" className="hover:text-zinc-700 dark:hover:text-zinc-300">
        ← Dashboard
      </Link>
      <span className="mx-1.5 text-zinc-400">/</span>
      <Link href="/admin/accounts" className="hover:text-zinc-700 dark:hover:text-zinc-300">
        Chart of accounts
      </Link>
      <span className="mx-1.5 text-zinc-400">/</span>
      <span className="normal-case text-zinc-700 dark:text-zinc-300">{account}</span>
    </div>
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
  colSpan,
}: {
  children: React.ReactNode;
  align?: "left" | "right";
  className?: string;
  colSpan?: number;
}) {
  const a = align === "right" ? "text-right tabular-nums" : "text-left";
  return (
    <td className={`${a} px-4 py-2 ${className}`} colSpan={colSpan}>
      {children}
    </td>
  );
}
