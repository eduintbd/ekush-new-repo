// /journals — list journal lines for the selected fiscal year. Filter by
// date range / account / fund / txn type / description / voucher number.
// Line-level view (each row is one debit or credit leg); shared batch_id
// (and voucher_no) groups compound entries.

import Link from "next/link";
import type { Prisma } from "@/generated/prisma";
import { requireStaff } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { formatBdt } from "@/lib/format";
import { PrintButton } from "@/components/print-button";
import { SavedBanner } from "./saved-banner";

type Search = {
  fy?: string;
  from?: string;
  to?: string;
  on?: string;
  account?: string;
  txnType?: string;
  q?: string;
  voucher?: string;
  page?: string;
  /** Set by createJournal redirect to flash a success toast. */
  created?: string;
  vno?: string;
  batch?: string;
};

const PAGE_SIZE = 50;
const TXN_TYPES = ["", "j", "OB", "c"];

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
  const page = Math.max(1, Number(sp.page ?? "1") || 1);
  // Single-day filter `on=YYYY-MM-DD` takes precedence over from/to.
  const onDay = sp.on && /^\d{4}-\d{2}-\d{2}$/.test(sp.on) ? sp.on : null;

  const where: Prisma.JournalWhereInput = fyId
    ? {
        fiscalYearId: fyId,
        ...(sp.account ? { accountName: { contains: sp.account, mode: "insensitive" } } : {}),
        ...(sp.txnType ? { txnType: sp.txnType } : {}),
        ...(sp.q ? { description: { contains: sp.q, mode: "insensitive" } } : {}),
        ...(sp.voucher
          ? { voucherNo: { contains: sp.voucher, mode: "insensitive" } }
          : {}),
        ...(onDay
          ? { entryDate: { gte: new Date(`${onDay}T00:00:00Z`), lte: new Date(`${onDay}T00:00:00Z`) } }
          : sp.from || sp.to
            ? {
                entryDate: {
                  ...(sp.from ? { gte: new Date(sp.from) } : {}),
                  ...(sp.to ? { lte: new Date(sp.to) } : {}),
                },
              }
            : {}),
      }
    : {};

  const [total, sums, lines] = fyId
    ? await Promise.all([
        prisma.journal.count({ where }).catch(() => 0),
        prisma.journal
          .aggregate({ where, _sum: { debit: true, credit: true } })
          .catch(() => ({ _sum: { debit: 0, credit: 0 } })),
        prisma.journal
          .findMany({
            where,
            orderBy: [{ entryDate: "desc" }, { voucherNo: "desc" }, { createdAt: "asc" }],
            take: PAGE_SIZE,
            skip: (page - 1) * PAGE_SIZE,
          })
          .catch(() => []),
      ])
    : [0, { _sum: { debit: 0, credit: 0 } }, []];

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const sumDebit = Number(sums._sum.debit ?? 0);
  const sumCredit = Number(sums._sum.credit ?? 0);
  const hasFilters = Boolean(
    sp.account || sp.txnType || sp.q || sp.voucher || sp.from || sp.to || onDay,
  );

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10 dark:bg-zinc-950">
      {sp.created === "1" && sp.vno && (
        <SavedBanner voucherNo={sp.vno} batchId={sp.batch ?? ""} />
      )}
      <div className="mx-auto max-w-7xl">
        <Link
          href="/dashboard"
          className="text-xs uppercase tracking-widest text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
        >
          ← Dashboard
        </Link>
        <div className="mt-3 flex items-end justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-widest text-zinc-500">Staff portal</p>
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
              Journals
            </h1>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              {total.toLocaleString()} line{total === 1 ? "" : "s"}{hasFilters ? " matching" : ""}
              {" · "}Σ debit {formatBdt(sumDebit)} · Σ credit {formatBdt(sumCredit)}
              {Math.abs(sumDebit - sumCredit) > 0.005 && (
                <span className="ml-2 text-red-600 dark:text-red-400">
                  ✗ unbalanced (Δ {formatBdt(sumDebit - sumCredit)})
                </span>
              )}
            </p>
          </div>
          <div className="no-print flex items-center gap-2">
            <a
              href={`/api/exports/csv/journals?${new URLSearchParams(Object.entries(sp).filter(([_, v]) => v !== undefined) as [string, string][]).toString()}`}
              className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800"
            >
              ⬇ CSV
            </a>
            <PrintButton />
            <Link
              href="/journals/new"
              className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900"
            >
              + New entry
            </Link>
          </div>
        </div>

        <form className="mt-6 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4 lg:grid-cols-8">
          <label className="block">
            <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
              Fiscal year
            </span>
            <select
              name="fy"
              defaultValue={fyId ?? ""}
              className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-900"
            >
              {fiscalYears.length === 0 && <option value="">No fiscal years</option>}
              {fiscalYears.map((y) => (
                <option key={y.id} value={y.id}>
                  {y.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">On day</span>
            <input
              type="date"
              name="on"
              defaultValue={onDay ?? ""}
              title="Show only this day's lines (overrides From/To)"
              className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
          <label className="block">
            <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">From</span>
            <input
              type="date"
              name="from"
              defaultValue={onDay ? "" : sp.from}
              className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
          <label className="block">
            <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">To</span>
            <input
              type="date"
              name="to"
              defaultValue={onDay ? "" : sp.to}
              className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
          <label className="block">
            <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">Account</span>
            <input
              name="account"
              placeholder="contains…"
              defaultValue={sp.account}
              className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
          <label className="block">
            <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">Type</span>
            <select
              name="txnType"
              defaultValue={sp.txnType ?? ""}
              className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-900"
            >
              {TXN_TYPES.map((t) => (
                <option key={t || "any"} value={t}>
                  {t || "any"}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">Description</span>
            <input
              name="q"
              placeholder="contains…"
              defaultValue={sp.q}
              className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
          <label className="block">
            <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">Voucher#</span>
            <input
              name="voucher"
              placeholder="JV/25-26/…"
              defaultValue={sp.voucher}
              className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
          <div className="col-span-2 mt-2 flex items-center gap-2 sm:col-span-4 lg:col-span-8">
            <button className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">
              Apply filters
            </button>
            {hasFilters && (
              <Link
                href={`/journals${fyId ? `?fy=${fyId}` : ""}`}
                className="text-xs text-zinc-500 underline hover:text-zinc-700 dark:hover:text-zinc-300"
              >
                Clear
              </Link>
            )}
            <span className="ml-auto text-xs text-zinc-500">
              Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of{" "}
              {total.toLocaleString()}
            </span>
          </div>
        </form>

        {fiscalYears.length === 0 ? (
          <p className="mt-10 text-sm text-zinc-500">
            No fiscal years yet. Run <code>npm run db:seed</code> to create FY2025-26.
          </p>
        ) : lines.length === 0 ? (
          <p className="mt-10 text-sm text-zinc-500">No journal lines for this filter.</p>
        ) : (
          <>
            <div className="mt-6 overflow-x-auto rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
              <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
                <thead className="bg-zinc-50 dark:bg-zinc-950">
                  <tr>
                    <Th>Date</Th>
                    <Th>Voucher#</Th>
                    <Th>Type</Th>
                    <Th>Account</Th>
                    <Th>Description</Th>
                    <Th>Instrument</Th>
                    <Th align="right">Debit</Th>
                    <Th align="right">Credit</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {lines.map((j) => (
                    <tr key={j.id}>
                      <Td className="whitespace-nowrap">{j.entryDate.toISOString().slice(0, 10)}</Td>
                      <Td className="font-mono text-xs text-zinc-600 dark:text-zinc-400">
                        {j.batchId && j.voucherNo ? (
                          <Link href={`/journals/voucher/${j.batchId}`} className="underline-offset-2 hover:underline">
                            {j.voucherNo}
                          </Link>
                        ) : (
                          j.voucherNo ?? "—"
                        )}
                      </Td>
                      <Td>
                        <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-zinc-600 dark:bg-zinc-800">
                          {j.txnType ?? "j"}
                        </span>
                      </Td>
                      <Td>
                        <Link
                          href={`/ledger/${encodeURIComponent(j.accountName)}${fyId ? `?fy=${fyId}` : ""}`}
                          className="underline-offset-2 hover:underline"
                        >
                          {j.accountName}
                        </Link>
                      </Td>
                      <Td className="text-zinc-600 dark:text-zinc-400">{j.description ?? "—"}</Td>
                      <Td>
                        {j.instrumentCode ? (
                          <Link
                            href={`/ledger/${encodeURIComponent(j.accountName)}?fy=${fyId}&instrument=${encodeURIComponent(j.instrumentCode)}`}
                            className="rounded bg-sky-100 px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wider text-sky-800 hover:bg-sky-200 dark:bg-sky-950 dark:text-sky-200 dark:hover:bg-sky-900"
                          >
                            {j.instrumentCode}
                          </Link>
                        ) : (
                          <span className="text-xs text-zinc-500">—</span>
                        )}
                      </Td>
                      <Td align="right">{Number(j.debit) > 0 ? formatBdt(Number(j.debit)) : "—"}</Td>
                      <Td align="right">{Number(j.credit) > 0 ? formatBdt(Number(j.credit)) : "—"}</Td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-zinc-50 dark:bg-zinc-950">
                  <tr className="font-semibold">
                    <Td colSpan={6}>Page totals</Td>
                    <Td align="right">
                      {formatBdt(
                        lines.reduce((s, j) => s + Number(j.debit), 0),
                      )}
                    </Td>
                    <Td align="right">
                      {formatBdt(
                        lines.reduce((s, j) => s + Number(j.credit), 0),
                      )}
                    </Td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {totalPages > 1 && (
              <Pagination
                page={page}
                totalPages={totalPages}
                searchParams={sp}
              />
            )}
          </>
        )}
      </div>
    </main>
  );
}

function Pagination({
  page,
  totalPages,
  searchParams,
}: {
  page: number;
  totalPages: number;
  searchParams: Search;
}) {
  const buildHref = (p: number) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(searchParams)) {
      if (v && k !== "page") params.set(k, v);
    }
    params.set("page", String(p));
    return `/journals?${params.toString()}`;
  };
  return (
    <div className="mt-4 flex items-center justify-center gap-2 text-sm">
      <PageLink href={buildHref(1)} disabled={page === 1}>
        ‹‹
      </PageLink>
      <PageLink href={buildHref(Math.max(1, page - 1))} disabled={page === 1}>
        ‹ Prev
      </PageLink>
      <span className="px-3 py-1 text-xs text-zinc-500">
        Page {page} of {totalPages}
      </span>
      <PageLink href={buildHref(Math.min(totalPages, page + 1))} disabled={page === totalPages}>
        Next ›
      </PageLink>
      <PageLink href={buildHref(totalPages)} disabled={page === totalPages}>
        ››
      </PageLink>
    </div>
  );
}

function PageLink({
  href,
  disabled,
  children,
}: {
  href: string;
  disabled: boolean;
  children: React.ReactNode;
}) {
  const cls =
    "rounded-md border border-zinc-300 px-2.5 py-1 text-xs font-medium dark:border-zinc-700";
  if (disabled) {
    return <span className={`${cls} cursor-not-allowed opacity-40`}>{children}</span>;
  }
  return (
    <Link href={href} className={`${cls} hover:bg-zinc-100 dark:hover:bg-zinc-800`}>
      {children}
    </Link>
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
