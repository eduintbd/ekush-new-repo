// /cash-book — summary view of every cash + bank + mobile-money ledger
// in one place, with closing balance per account. Click into any row to
// open its full ledger card.
//
// Identification: account where the category contains 'cash' or 'bank'
// case-insensitive, OR name matches known bank/MM keywords. Set
// category explicitly on /admin/accounts/[id] to make this list accurate.

import Link from "next/link";
import type { Prisma } from "@/generated/prisma";
import { requireStaff } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { formatBdt } from "@/lib/format";
import { PrintButton } from "@/components/print-button";

type Search = { fy?: string };

const NAME_PATTERN =
  /(cash|bank|brac|ucb|bkash|nagad|rocket|mtbl|dbbl|ebl|std account|dutch|eastern|premier|prime|nccb|ab bank|city bank|midland|sonali|janata|agrani|rupali)/i;

export const metadata = { title: "Cash & Bank Book — Staff portal" };

export default async function CashBookPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  await requireStaff();
  const sp = await searchParams;

  const fiscalYears = await prisma.fiscalYear
    .findMany({ orderBy: { startsOn: "desc" }, select: { id: true, label: true } })
    .catch(() => []);
  const fyId = sp.fy ?? fiscalYears[0]?.id ?? null;

  if (!fyId) {
    return (
      <main className="min-h-screen bg-zinc-50 px-6 py-10 dark:bg-zinc-950">
        <div className="mx-auto max-w-6xl">
          <Crumb />
          <p className="mt-10 text-sm text-zinc-500">No fiscal years. Seed the DB first.</p>
        </div>
      </main>
    );
  }

  // Identify cash & bank accounts: category match OR name keyword match.
  const accountFilter: Prisma.ChartOfAccountWhereInput = {
    AND: [
      { isActive: true },
      {
        OR: [
          { category: { contains: "cash", mode: "insensitive" } },
          { category: { contains: "bank", mode: "insensitive" } },
          // Name-keyword fallback (Postgres regex via mode: 'insensitive' + contains is OR).
          // We can't run a single regex via Prisma, so list common patterns:
          { name: { contains: "cash", mode: "insensitive" } },
          { name: { contains: "bank", mode: "insensitive" } },
          { name: { contains: "brac", mode: "insensitive" } },
          { name: { contains: "ucb", mode: "insensitive" } },
          { name: { contains: "bkash", mode: "insensitive" } },
          { name: { contains: "nagad", mode: "insensitive" } },
          { name: { contains: "rocket", mode: "insensitive" } },
          { name: { contains: "mtbl", mode: "insensitive" } },
          { name: { contains: "dbbl", mode: "insensitive" } },
          { name: { contains: "ebl", mode: "insensitive" } },
          { name: { contains: "std account", mode: "insensitive" } },
          { name: { contains: "midland", mode: "insensitive" } },
          { name: { contains: "premier", mode: "insensitive" } },
          { name: { contains: "prime", mode: "insensitive" } },
          { name: { contains: "nccb", mode: "insensitive" } },
        ],
      },
    ],
  };

  const candidates = await prisma.chartOfAccount.findMany({
    where: accountFilter,
    orderBy: { sl: "asc" },
  });

  // Narrow further with a strict regex pass (catches things like "Margin Loan
  // From UCB" we don't want, since that's a liability, not a bank balance).
  // We accept an account if it's tagged Cash/Bank in category OR if its
  // normalBalance is DEBIT (asset) AND name matches NAME_PATTERN.
  const banks = candidates.filter((a) => {
    if (a.category && /cash|bank/i.test(a.category)) return true;
    if (a.normalBalance !== "DEBIT") return false;
    return NAME_PATTERN.test(a.name);
  });

  if (banks.length === 0) {
    return (
      <main className="min-h-screen bg-zinc-50 px-6 py-10 dark:bg-zinc-950">
        <div className="mx-auto max-w-6xl">
          <Crumb />
          <h1 className="mt-3 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
            Cash & Bank Book
          </h1>
          <p className="mt-3 text-sm text-zinc-500">
            No cash or bank accounts detected. Open{" "}
            <Link href="/admin/accounts" className="underline">
              Chart of accounts
            </Link>{" "}
            and set <code>category</code> to <strong>Cash and bank balances</strong> on the relevant rows.
          </p>
        </div>
      </main>
    );
  }

  // Aggregate balances for each detected account, in one query.
  const sums = await prisma.journal.groupBy({
    by: ["accountName"],
    where: { fiscalYearId: fyId, accountName: { in: banks.map((b) => b.name) } },
    _sum: { debit: true, credit: true },
  });
  const sumMap = new Map(sums.map((s) => [s.accountName, s]));

  type Row = {
    name: string;
    category: string | null;
    normalBalance: string;
    periodDebit: number;
    periodCredit: number;
    closing: number; // signed: + = Dr, − = Cr
    lineCount: number;
  };
  const rows: Row[] = banks.map((b) => {
    const agg = sumMap.get(b.name);
    const periodDebit = Number(agg?._sum.debit ?? 0);
    const periodCredit = Number(agg?._sum.credit ?? 0);
    return {
      name: b.name,
      category: b.category,
      normalBalance: b.normalBalance,
      periodDebit,
      periodCredit,
      closing: periodDebit - periodCredit,
      lineCount: 0, // computed below
    };
  });

  // Line count per account (could be merged with the groupBy above but easier this way)
  const counts = await prisma.journal.groupBy({
    by: ["accountName"],
    where: { fiscalYearId: fyId, accountName: { in: banks.map((b) => b.name) } },
    _count: { _all: true },
  });
  const countMap = new Map(counts.map((c) => [c.accountName, c._count._all]));
  for (const r of rows) r.lineCount = countMap.get(r.name) ?? 0;

  // Sort: accounts with activity first (by closing balance desc), then idle ones
  rows.sort((a, b) => {
    const aHas = a.lineCount > 0;
    const bHas = b.lineCount > 0;
    if (aHas !== bHas) return aHas ? -1 : 1;
    return Math.abs(b.closing) - Math.abs(a.closing);
  });

  const totalDr = rows.reduce((s, r) => s + Math.max(0, r.closing), 0);
  const totalCr = rows.reduce((s, r) => s + Math.max(0, -r.closing), 0);
  const netPosition = rows.reduce((s, r) => s + r.closing, 0);

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10 dark:bg-zinc-950">
      <div className="mx-auto max-w-6xl">
        <Crumb />
        <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-widest text-zinc-500">Staff portal</p>
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
              Cash &amp; Bank Book
            </h1>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              {rows.length} account{rows.length === 1 ? "" : "s"} · Net position{" "}
              <strong>{drCr(netPosition)}</strong>
            </p>
          </div>
          <form className="flex items-end gap-2 text-sm">
            <label className="block">
              <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
                Fiscal year
              </span>
              <select
                name="fy"
                defaultValue={fyId}
                className="mt-1 block w-44 rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-900"
              >
                {fiscalYears.map((y) => (
                  <option key={y.id} value={y.id}>
                    {y.label}
                  </option>
                ))}
              </select>
            </label>
            <button className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">
              Apply
            </button>
            <PrintButton />
          </form>
        </div>

        <div className="mt-6 overflow-x-auto rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
            <thead className="bg-zinc-50 dark:bg-zinc-950">
              <tr>
                <Th>Account</Th>
                <Th>Category</Th>
                <Th align="right">Lines</Th>
                <Th align="right">Σ Debit</Th>
                <Th align="right">Σ Credit</Th>
                <Th align="right">Closing balance</Th>
                <Th />
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {rows.map((r) => (
                <tr key={r.name} className={r.lineCount === 0 ? "opacity-50" : ""}>
                  <Td className="font-medium">
                    <Link
                      href={`/ledger/${encodeURIComponent(r.name)}?fy=${fyId}`}
                      className="underline-offset-2 hover:underline"
                    >
                      {r.name}
                    </Link>
                  </Td>
                  <Td className="text-xs text-zinc-500">{r.category ?? "—"}</Td>
                  <Td align="right" className="font-mono text-xs">
                    {r.lineCount}
                  </Td>
                  <Td align="right">{r.periodDebit > 0 ? formatBdt(r.periodDebit) : "—"}</Td>
                  <Td align="right">{r.periodCredit > 0 ? formatBdt(r.periodCredit) : "—"}</Td>
                  <Td align="right" className="font-medium">
                    {drCr(r.closing)}
                  </Td>
                  <Td>
                    <Link
                      href={`/ledger/${encodeURIComponent(r.name)}?fy=${fyId}`}
                      className="text-xs underline"
                    >
                      open →
                    </Link>
                  </Td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-zinc-50 dark:bg-zinc-950">
              <tr className="font-semibold">
                <Td colSpan={5}>Totals</Td>
                <Td align="right">
                  {formatBdt(totalDr)} Dr / {formatBdt(totalCr)} Cr
                </Td>
                <Td />
              </tr>
            </tfoot>
          </table>
        </div>

        <p className="mt-4 text-[11px] text-zinc-500">
          Detection: <code>category</code> contains "cash"/"bank" OR <code>name</code> matches a
          known bank/MM keyword AND the account has DEBIT normal balance. Set <code>category</code>{" "}
          explicitly on <Link href="/admin/accounts" className="underline">Chart of accounts</Link> for accurate inclusion.
        </p>
      </div>
    </main>
  );
}

function drCr(amount: number): string {
  if (Math.abs(amount) < 0.005) return "—";
  return `${formatBdt(Math.abs(amount))} ${amount > 0 ? "Dr" : "Cr"}`;
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

function Th({
  children,
  align = "left",
}: {
  children?: React.ReactNode;
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
  children?: React.ReactNode;
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
