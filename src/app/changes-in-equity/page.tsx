// /changes-in-equity — Statement of Changes in Equity for the selected
// fiscal year (spec §5.11 CE sheet). Mirrors the workbook CE tab —
// columns: Paid-up Capital, Fair Value Reserve, Retained Earnings, Total;
// rows: opening, dividend paid, share issue, comprehensive income,
// prior-year adjustment, OCI, closing.
//
// All inputs derive from data the system already has (opening balances +
// IS profit / OCI + journal activity on equity accounts). Accountant
// overrides (`mgmtFeeTax`, `fvLoss`, `fvRecv`) propagate through IS.

import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { formatBdt } from "@/lib/format";
import { getStatements, type StatementOverrides } from "@/lib/statements";
import { requireStaff } from "@/lib/auth";
import type { ChangesInEquity, ChangesInEquityRow } from "@/lib/statement_mapping";

type Search = {
  fy?: string;
  mgmtFeeTax?: string;
  fvLoss?: string;
  fvRecv?: string;
};

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

function parseOverrides(sp: Search): StatementOverrides {
  const out: StatementOverrides = {};
  if (sp.mgmtFeeTax !== undefined && sp.mgmtFeeTax !== "") {
    const v = Number(sp.mgmtFeeTax);
    if (Number.isFinite(v)) out.mgmtFeeTaxAtSource = v;
  }
  if (sp.fvLoss !== undefined && sp.fvLoss !== "") {
    const v = Number(sp.fvLoss);
    if (Number.isFinite(v)) out.unrealisedFairValueLoss = v;
  }
  if (sp.fvRecv !== undefined && sp.fvRecv !== "") {
    const v = Number(sp.fvRecv);
    if (Number.isFinite(v)) out.fairValueReceivableAdjustment = v;
  }
  return out;
}

export default async function ChangesInEquityPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  await requireStaff();
  const sp = await searchParams;
  const fiscalYears = await loadFiscalYears();

  if (fiscalYears === null) return <NotConnected />;
  if (fiscalYears.length === 0) return <NoFiscalYears />;

  const selectedId = sp.fy ?? fiscalYears[0].id;
  const overrides = parseOverrides(sp);

  let statements;
  try {
    statements = await getStatements(selectedId, overrides);
  } catch {
    statements = null;
  }

  return (
    <main className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <div className="mx-auto max-w-5xl px-6 py-10">
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-widest text-zinc-500">
              Staff portal
            </p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
              Statement of Changes in Equity
            </h1>
            <p className="mt-1 text-xs text-zinc-500">
              Rollforward of paid-up capital, fair value reserve, and retained earnings
            </p>
          </div>
          <FiscalYearPicker years={fiscalYears} selectedId={selectedId} overrides={overrides} />
        </div>

        {statements ? (
          <Report
            ce={statements.changesInEquity}
            fyLabel={statements.fiscalYear.label}
            bsEquityTotal={statements.balanceSheet.equity.reduce((s, l) => s + l.amount, 0)}
          />
        ) : (
          <p className="mt-10 text-sm text-zinc-500">
            Could not load report — fiscal year may not exist.
          </p>
        )}

        <div className="mt-8">
          <Link href="/dashboard" className="text-sm text-zinc-600 underline dark:text-zinc-400">
            ← Back to dashboard
          </Link>
        </div>
      </div>
    </main>
  );
}

// ─── Components ──────────────────────────────────────────────────

function Report({
  ce,
  fyLabel,
  bsEquityTotal,
}: {
  ce: ChangesInEquity;
  fyLabel: string;
  bsEquityTotal: number;
}) {
  const reconciled = Math.abs(ce.current.closingTotal - bsEquityTotal) < 1;

  return (
    <div className="mt-8">
      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">{fyLabel}</p>
        {reconciled ? (
          <span className="inline-flex items-center rounded-full bg-emerald-100 px-3 py-1 text-xs font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
            ✓ Closing equity reconciles with BS
          </span>
        ) : (
          <span className="inline-flex items-center rounded-full bg-red-100 px-3 py-1 text-xs font-medium text-red-700 dark:bg-red-950 dark:text-red-300">
            ✗ Closing equity ≠ BS equity total
          </span>
        )}
      </div>

      <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
          <thead className="bg-zinc-50 text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:bg-zinc-950">
            <tr>
              <th className="px-4 py-3 text-left">Particular</th>
              <th className="px-4 py-3 text-right">Paid-up Capital</th>
              <th className="px-4 py-3 text-right">Fair Value Reserve</th>
              <th className="px-4 py-3 text-right">Retained Earnings</th>
              <th className="px-4 py-3 text-right">Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {ce.current.rows.map((r, i) => (
              <Row key={`${r.label}-${i}`} row={r} />
            ))}
          </tbody>
        </table>
      </div>

      {ce.needsInputs.length > 0 && (
        <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <p className="font-medium">Inputs needed for full CE rollforward:</p>
          <ul className="mt-1 list-inside list-disc">
            {ce.needsInputs.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
          <p className="mt-1">
            Fallback used TB net-credit balances; closing reconciles against BS but the
            opening row reflects current-period TB rather than true opening.
          </p>
        </div>
      )}
    </div>
  );
}

function Row({ row }: { row: ChangesInEquityRow }) {
  const cls = row.subtotal
    ? "bg-zinc-100 font-semibold dark:bg-zinc-800"
    : "";
  return (
    <tr className={cls}>
      <td className={`px-4 py-2 ${row.subtotal ? "" : "pl-8"}`}>{row.label}</td>
      <td className="px-4 py-2 text-right tabular-nums">{fmt(row.paidUpCapital)}</td>
      <td className="px-4 py-2 text-right tabular-nums">{fmt(row.fairValueReserve)}</td>
      <td className="px-4 py-2 text-right tabular-nums">{fmt(row.retainedEarnings)}</td>
      <td className="px-4 py-2 text-right tabular-nums">{fmt(row.total)}</td>
    </tr>
  );
}

function fmt(n: number): string {
  return n === 0 ? "—" : formatBdt(n);
}

function FiscalYearPicker({
  years,
  selectedId,
  overrides,
}: {
  years: Array<{ id: string; label: string }>;
  selectedId: string;
  overrides: StatementOverrides;
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
      {overrides.mgmtFeeTaxAtSource !== undefined && (
        <input type="hidden" name="mgmtFeeTax" value={overrides.mgmtFeeTaxAtSource} />
      )}
      {overrides.unrealisedFairValueLoss !== undefined && (
        <input type="hidden" name="fvLoss" value={overrides.unrealisedFairValueLoss} />
      )}
      {overrides.fairValueReceivableAdjustment !== undefined && (
        <input type="hidden" name="fvRecv" value={overrides.fairValueReceivableAdjustment} />
      )}
      <button
        type="submit"
        className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900"
      >
        View
      </button>
    </form>
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
          Set <code className="font-mono">DATABASE_URL</code> in <code className="font-mono">.env.local</code>.
        </p>
        <Link href="/" className="mt-6 inline-block text-sm font-medium text-zinc-900 underline dark:text-zinc-50">
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
          Run <code className="font-mono">npm run db:seed</code>.
        </p>
      </div>
    </main>
  );
}
