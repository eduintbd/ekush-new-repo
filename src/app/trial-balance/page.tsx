// /trial-balance — staff portal page (will move under (admin) once auth exists).
// Renders the per-account net debit / net credit for the selected fiscal year
// in CoA SL order, with a Σ-balance check banner.
//
// Server component — pure read of FiscalYear + Journal aggregates.

import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { formatBdt } from "@/lib/format";
import { getTrialBalance, type TrialBalanceReport } from "@/lib/trial-balance";
import { requireStaff } from "@/lib/auth";

type Search = { fy?: string };

async function loadFiscalYears(): Promise<Array<{ id: string; label: string }> | null> {
  try {
    return await prisma.fiscalYear.findMany({
      orderBy: { startsOn: "desc" },
      select: { id: true, label: true },
    });
  } catch {
    return null;
  }
}

async function loadReport(fyId: string): Promise<TrialBalanceReport | null> {
  try {
    return await getTrialBalance(fyId);
  } catch {
    return null;
  }
}

export default async function TrialBalancePage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  await requireStaff();
  const sp = await searchParams;
  const fiscalYears = await loadFiscalYears();

  if (fiscalYears === null) {
    return <NotConnected />;
  }
  if (fiscalYears.length === 0) {
    return <NoFiscalYears />;
  }

  const selectedId = sp.fy ?? fiscalYears[0].id;
  const report = await loadReport(selectedId);

  return (
    <main className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <div className="mx-auto max-w-6xl px-6 py-10">
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-widest text-zinc-500">
              Staff portal
            </p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
              Trial Balance
            </h1>
          </div>
          <FiscalYearPicker years={fiscalYears} selectedId={selectedId} />
        </div>

        {report ? (
          <ReportTable report={report} />
        ) : (
          <p className="mt-10 text-sm text-zinc-500">
            Could not load report — fiscal year may not exist.
          </p>
        )}
      </div>
    </main>
  );
}

// ─── Components ──────────────────────────────────────────────────

function FiscalYearPicker({
  years,
  selectedId,
}: {
  years: Array<{ id: string; label: string }>;
  selectedId: string;
}) {
  return (
    <form action="" className="flex items-center gap-2">
      <label htmlFor="fy" className="text-xs uppercase tracking-wide text-zinc-500">
        Fiscal year
      </label>
      <select
        id="fy"
        name="fy"
        defaultValue={selectedId}
        className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
      >
        {years.map((y) => (
          <option key={y.id} value={y.id}>
            {y.label}
          </option>
        ))}
      </select>
      <button
        type="submit"
        className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900"
      >
        View
      </button>
    </form>
  );
}

function ReportTable({ report }: { report: TrialBalanceReport }) {
  const periodLabel = `${report.startsOn.toISOString().slice(0, 10)} → ${report.endsOn.toISOString().slice(0, 10)}`;

  return (
    <div className="mt-8">
      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          {report.fiscalYearLabel} — {periodLabel}
        </p>
        <BalanceBadge isBalanced={report.isBalanced} totals={report.totals} />
      </div>

      <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
          <thead className="bg-zinc-50 dark:bg-zinc-950">
            <tr>
              <Th align="right">SL</Th>
              <Th>Account</Th>
              <Th align="center">Normal</Th>
              <Th align="right">Period Debit</Th>
              <Th align="right">Period Credit</Th>
              <Th align="right">Net Debit (K)</Th>
              <Th align="right">Net Credit (L)</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {report.rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-sm text-zinc-500">
                  No accounts. Run <code>npm run db:seed</code> to load the chart of accounts.
                </td>
              </tr>
            ) : (
              report.rows.map((r) => {
                const hasActivity = r.grossDebit > 0 || r.grossCredit > 0;
                return (
                  <tr key={r.accountName} className={hasActivity ? "" : "text-zinc-400"}>
                    <Td align="right">{r.sl}</Td>
                    <Td>{r.accountName}</Td>
                    <Td align="center">
                      <span className="rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-zinc-500">
                        {r.normalBalance.slice(0, 2)}
                      </span>
                    </Td>
                    <Td align="right">{r.grossDebit ? formatBdt(r.grossDebit) : "—"}</Td>
                    <Td align="right">{r.grossCredit ? formatBdt(r.grossCredit) : "—"}</Td>
                    <Td align="right" className="font-medium">{r.netDebit ? formatBdt(r.netDebit) : "—"}</Td>
                    <Td align="right" className="font-medium">{r.netCredit ? formatBdt(r.netCredit) : "—"}</Td>
                  </tr>
                );
              })
            )}
          </tbody>
          {report.rows.length > 0 && (
            <tfoot className="bg-zinc-50 dark:bg-zinc-950">
              <tr className="font-semibold">
                <Td align="right" colSpan={3}>Totals</Td>
                <Td align="right">{formatBdt(report.totals.grossDebit)}</Td>
                <Td align="right">{formatBdt(report.totals.grossCredit)}</Td>
                <Td align="right">{formatBdt(report.totals.netDebit)}</Td>
                <Td align="right">{formatBdt(report.totals.netCredit)}</Td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

function BalanceBadge({
  isBalanced,
  totals,
}: {
  isBalanced: boolean;
  totals: TrialBalanceReport["totals"];
}) {
  if (isBalanced) {
    return (
      <span className="inline-flex items-center rounded-full bg-emerald-100 px-3 py-1 text-xs font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
        ✓ Balanced
      </span>
    );
  }
  const diff = totals.netDebit - totals.netCredit;
  return (
    <span className="inline-flex items-center rounded-full bg-red-100 px-3 py-1 text-xs font-medium text-red-700 dark:bg-red-950 dark:text-red-300">
      ✗ Out of balance — Σdebit − Σcredit = BDT {formatBdt(diff)}
    </span>
  );
}

function NotConnected() {
  return (
    <main className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <div className="mx-auto max-w-2xl px-6 py-20">
        <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
          Database not connected
        </h1>
        <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">
          Set <code className="font-mono">DATABASE_URL</code> in <code className="font-mono">.env.local</code>,
          then run:
        </p>
        <pre className="mt-4 rounded-md bg-zinc-900 p-4 text-xs text-zinc-100 dark:bg-zinc-800">{`npx prisma migrate dev
npm run db:seed`}</pre>
        <p className="mt-4 text-xs text-zinc-500">
          See <code className="font-mono">README.md</code> and <code className="font-mono">.env.example</code> for setup.
        </p>
        <Link
          href="/"
          className="mt-6 inline-block text-sm font-medium text-zinc-900 underline dark:text-zinc-50"
        >
          ← Back home
        </Link>
      </div>
    </main>
  );
}

function NoFiscalYears() {
  return (
    <main className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <div className="mx-auto max-w-2xl px-6 py-20">
        <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
          No fiscal year defined
        </h1>
        <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">
          Run <code className="font-mono">npm run db:seed</code> — it will
          create FY2025-26 (Jul 1, 2025 → Jun 30, 2026).
        </p>
      </div>
    </main>
  );
}

// ─── Tiny table primitives ───────────────────────────────────────

function Th({
  children,
  align = "left",
}: {
  children: React.ReactNode;
  align?: "left" | "center" | "right";
}) {
  const alignCls =
    align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left";
  return (
    <th
      className={`${alignCls} px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500`}
      scope="col"
    >
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
  align?: "left" | "center" | "right";
  className?: string;
  colSpan?: number;
}) {
  const alignCls =
    align === "right" ? "text-right tabular-nums" : align === "center" ? "text-center" : "text-left";
  return (
    <td className={`${alignCls} px-4 py-2 ${className}`} colSpan={colSpan}>
      {children}
    </td>
  );
}
