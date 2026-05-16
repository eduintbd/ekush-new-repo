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
import { PrintButton } from "@/components/print-button";

type Search = { fy?: string; compare?: string };

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
  const compareId = sp.compare && sp.compare !== selectedId ? sp.compare : undefined;
  const [report, compareReport] = await Promise.all([
    loadReport(selectedId),
    compareId ? loadReport(compareId) : Promise.resolve(null),
  ]);

  return (
    <main className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <div className="mx-auto max-w-6xl px-6 py-10 print-area">
        <Link href="/dashboard" className="no-print text-xs uppercase tracking-widest text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
          ← Dashboard
        </Link>
        <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-widest text-zinc-500">
              Ekush Wealth Management Limited
            </p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
              Trial Balance
            </h1>
            <p className="print-only text-xs text-zinc-600">Generated {new Date().toISOString().slice(0, 10)}</p>
          </div>
          <FiscalYearPicker years={fiscalYears} selectedId={selectedId} compareId={compareId} />
        </div>

        {report ? (
          <ReportTable report={report} compareReport={compareReport} />
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
  compareId,
}: {
  years: Array<{ id: string; label: string }>;
  selectedId: string;
  compareId?: string;
}) {
  return (
    <div className="no-print flex flex-wrap items-center gap-2">
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
        <label className="text-xs uppercase tracking-wide text-zinc-500">Compare with</label>
        <select
          name="compare"
          defaultValue={compareId ?? ""}
          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        >
          <option value="">— none —</option>
          {years.filter((y) => y.id !== selectedId).map((y) => (
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
      <a
        href={`/api/exports/csv/trial-balance?fy=${selectedId}`}
        className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800"
      >
        ⬇ CSV
      </a>
      <a
        href={`/api/exports/year-end?fiscalYearId=${selectedId}`}
        className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800"
        title="Download full year-end workbook"
      >
        ⬇ .xlsx
      </a>
      <PrintButton />
    </div>
  );
}

function ReportTable({
  report,
  compareReport,
}: {
  report: TrialBalanceReport;
  compareReport: TrialBalanceReport | null;
}) {
  const periodLabel = `${report.startsOn.toISOString().slice(0, 10)} → ${report.endsOn.toISOString().slice(0, 10)}`;
  const compareMap = compareReport
    ? new Map(compareReport.rows.map((r) => [r.accountName, r]))
    : null;

  return (
    <div className="mt-8">
      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          {report.fiscalYearLabel} — {periodLabel}
          {compareReport && (
            <> · compared with <strong>{compareReport.fiscalYearLabel}</strong></>
          )}
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
              {!compareReport && <Th align="right">Period Debit</Th>}
              {!compareReport && <Th align="right">Period Credit</Th>}
              <Th align="right">{compareReport ? `Net Dr — ${report.fiscalYearLabel}` : "Net Debit (K)"}</Th>
              <Th align="right">{compareReport ? `Net Cr — ${report.fiscalYearLabel}` : "Net Credit (L)"}</Th>
              {compareReport && <Th align="right">{`Net Dr — ${compareReport.fiscalYearLabel}`}</Th>}
              {compareReport && <Th align="right">{`Net Cr — ${compareReport.fiscalYearLabel}`}</Th>}
              {compareReport && <Th align="right">Variance (current − prior)</Th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {report.rows.length === 0 ? (
              <tr>
                <td colSpan={compareReport ? 9 : 7} className="px-4 py-12 text-center text-sm text-zinc-500">
                  No accounts. Run <code>npm run db:seed</code> to load the chart of accounts.
                </td>
              </tr>
            ) : (
              report.rows.map((r) => {
                const cmp = compareMap?.get(r.accountName);
                const curNet = r.netDebit - r.netCredit; // signed Dr-positive
                const cmpNet = cmp ? cmp.netDebit - cmp.netCredit : 0;
                const variance = curNet - cmpNet;
                const hasActivity = r.grossDebit > 0 || r.grossCredit > 0 || (cmp && (cmp.grossDebit > 0 || cmp.grossCredit > 0));
                return (
                  <tr key={r.accountName} className={hasActivity ? "" : "text-zinc-400"}>
                    <Td align="right">{r.sl}</Td>
                    <Td>{r.accountName}</Td>
                    <Td align="center">
                      <span className="rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-zinc-500">
                        {r.normalBalance.slice(0, 2)}
                      </span>
                    </Td>
                    {!compareReport && <Td align="right">{r.grossDebit ? formatBdt(r.grossDebit) : "—"}</Td>}
                    {!compareReport && <Td align="right">{r.grossCredit ? formatBdt(r.grossCredit) : "—"}</Td>}
                    <Td align="right" className="font-medium">{r.netDebit ? formatBdt(r.netDebit) : "—"}</Td>
                    <Td align="right" className="font-medium">{r.netCredit ? formatBdt(r.netCredit) : "—"}</Td>
                    {compareReport && (
                      <>
                        <Td align="right">{cmp?.netDebit ? formatBdt(cmp.netDebit) : "—"}</Td>
                        <Td align="right">{cmp?.netCredit ? formatBdt(cmp.netCredit) : "—"}</Td>
                        <Td align="right" className={Math.abs(variance) < 0.005 ? "text-zinc-400" : variance > 0 ? "text-emerald-700 dark:text-emerald-300" : "text-red-700 dark:text-red-300"}>
                          {Math.abs(variance) < 0.005 ? "—" : `${variance > 0 ? "+" : "−"}${formatBdt(Math.abs(variance))}`}
                        </Td>
                      </>
                    )}
                  </tr>
                );
              })
            )}
          </tbody>
          {report.rows.length > 0 && (
            <tfoot className="bg-zinc-50 dark:bg-zinc-950">
              <tr className="font-semibold">
                <Td align="right" colSpan={3}>Totals</Td>
                {!compareReport && <Td align="right">{formatBdt(report.totals.grossDebit)}</Td>}
                {!compareReport && <Td align="right">{formatBdt(report.totals.grossCredit)}</Td>}
                <Td align="right">{formatBdt(report.totals.netDebit)}</Td>
                <Td align="right">{formatBdt(report.totals.netCredit)}</Td>
                {compareReport && (
                  <>
                    <Td align="right">{formatBdt(compareReport.totals.netDebit)}</Td>
                    <Td align="right">{formatBdt(compareReport.totals.netCredit)}</Td>
                    <Td align="right">—</Td>
                  </>
                )}
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
