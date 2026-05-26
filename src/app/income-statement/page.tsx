// /income-statement — Statement of Profit or Loss + OCI for the selected
// fiscal year (spec §5.11 IS sheet). Mirrors the workbook IS. tab.
//
// Tax provision auto-derives from TB (capitalGain × 15% + dividend × 20%);
// `mgmtFeeTax` is the only remaining accountant input — the source-tax
// withheld on Management Fee receipts (Notes (2)!F11). Other overrides:
//   /income-statement?fy=…&mgmtFeeTax=661963&fvLoss=620000

import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { formatBdt } from "@/lib/format";
import { getStatements, type StatementOverrides } from "@/lib/statements";
import { requireStaff } from "@/lib/auth";
import type { IncomeStatement, StatementLine } from "@/lib/statement_mapping";
import { PrintButton } from "@/components/print-button";

type Search = {
  fy?: string;
  compare?: string;
  /** "year" (default) | "period" (same days-into-FY YTD). */
  cmode?: string;
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

export default async function IncomeStatementPage({
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
  const compareMode: "year" | "period" = sp.cmode === "period" ? "period" : "year";
  const overrides = parseOverrides(sp);

  const fyRecords = await prisma.fiscalYear.findMany({
    where: { id: { in: compareId ? [selectedId, compareId] : [selectedId] } },
    select: { id: true, startsOn: true, endsOn: true },
  });
  const fyById = new Map(fyRecords.map((y) => [y.id, y]));
  const currentFy = fyById.get(selectedId);
  const compareFy = compareId ? fyById.get(compareId) : undefined;

  let currentAsOf: Date | undefined;
  let compareAsOf: Date | undefined;
  if (compareMode === "period" && currentFy && compareFy) {
    const today = new Date();
    const clamp = (d: Date, lo: Date, hi: Date) =>
      d < lo ? new Date(lo) : d > hi ? new Date(hi) : new Date(d);
    currentAsOf = clamp(today, currentFy.startsOn, currentFy.endsOn);
    const daysIn = Math.floor(
      (currentAsOf.getTime() - currentFy.startsOn.getTime()) / 86_400_000,
    );
    const target = new Date(compareFy.startsOn);
    target.setUTCDate(target.getUTCDate() + daysIn);
    compareAsOf = clamp(target, compareFy.startsOn, compareFy.endsOn);
  }

  let statements;
  let compareStatements;
  try {
    [statements, compareStatements] = await Promise.all([
      getStatements(selectedId, overrides, currentAsOf),
      compareId ? getStatements(compareId, overrides, compareAsOf) : Promise.resolve(null),
    ]);
  } catch {
    statements = null;
    compareStatements = null;
  }

  return (
    <main className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <div className="mx-auto max-w-4xl px-6 py-10">
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-widest text-zinc-500">
              Staff portal
            </p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
              Income Statement
            </h1>
            <p className="mt-1 text-xs text-zinc-500">
              Statement of Profit or Loss and Other Comprehensive Income
            </p>
          </div>
          <div className="no-print flex flex-wrap items-center gap-2">
            <FiscalYearPicker
              years={fiscalYears}
              selectedId={selectedId}
              overrides={overrides}
              compareId={compareId}
              compareMode={compareMode}
            />
            <PrintButton />
          </div>
        </div>

        {statements ? (
          <>
            <ExternalInputsBanner overrides={overrides} />
            <Report
              statement={statements.incomeStatement}
              fyLabel={
                currentAsOf
                  ? `${statements.fiscalYear.label} (YTD to ${currentAsOf.toISOString().slice(0, 10)})`
                  : statements.fiscalYear.label
              }
              compareStatement={compareStatements?.incomeStatement ?? null}
              compareLabel={
                compareStatements
                  ? compareAsOf
                    ? `${compareStatements.fiscalYear.label} (YTD to ${compareAsOf.toISOString().slice(0, 10)})`
                    : compareStatements.fiscalYear.label
                  : null
              }
            />
          </>
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
  statement,
  fyLabel,
  compareStatement,
  compareLabel,
}: {
  statement: IncomeStatement;
  fyLabel: string;
  compareStatement: IncomeStatement | null;
  compareLabel: string | null;
}) {
  const ociTotal = statement.oci.reduce((s, l) => s + l.amount, 0);
  const tciCheck = Math.abs(
    statement.profitForPeriod + ociTotal - statement.totalComprehensiveIncome,
  ) < 1;
  const sumLines = (lines: StatementLine[]) => lines.reduce((s, l) => s + l.amount, 0);

  return (
    <div className="mt-8">
      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          {fyLabel}
          {compareLabel && <> · compared with <strong>{compareLabel}</strong></>}
        </p>
        {tciCheck ? (
          <span className="inline-flex items-center rounded-full bg-emerald-100 px-3 py-1 text-xs font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
            ✓ TCI reconciled
          </span>
        ) : (
          <span className="inline-flex items-center rounded-full bg-red-100 px-3 py-1 text-xs font-medium text-red-700 dark:bg-red-950 dark:text-red-300">
            ✗ TCI mismatch
          </span>
        )}
      </div>

      <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
          {compareStatement && (
            <thead className="bg-zinc-50 text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:bg-zinc-950">
              <tr>
                <th className="px-4 py-2 text-left">Item</th>
                <th className="px-4 py-2 text-right">{fyLabel}</th>
                <th className="px-4 py-2 text-right">{compareLabel}</th>
              </tr>
            </thead>
          )}
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            <Section title="Operating Income" lines={statement.operatingIncome} compare={compareStatement?.operatingIncome} />
            <SubtotalRow
              label="Total Operating Income"
              amount={sumLines(statement.operatingIncome)}
              compareAmount={compareStatement ? sumLines(compareStatement.operatingIncome) : null}
            />

            <Section title="Operating Expenses" lines={statement.operatingExpenses} negate compare={compareStatement?.operatingExpenses} />
            <Section title="Financial Expenses" lines={statement.financialExpenses} negate compare={compareStatement?.financialExpenses} />

            <TotalRow label="Profit Before Tax" amount={statement.profitBeforeTax} compareAmount={compareStatement?.profitBeforeTax ?? null} />

            <Section title="Income Tax" lines={statement.taxExpense} negate compare={compareStatement?.taxExpense} />

            <TotalRow label="Profit For the Period" amount={statement.profitForPeriod} compareAmount={compareStatement?.profitForPeriod ?? null} />

            <Section title="Other Comprehensive Income" lines={statement.oci} compare={compareStatement?.oci} />

            <TotalRow label="Total Comprehensive Income" amount={statement.totalComprehensiveIncome} compareAmount={compareStatement?.totalComprehensiveIncome ?? null} emphatic />
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Section({
  title,
  lines,
  negate = false,
  compare,
}: {
  title: string;
  lines: StatementLine[];
  /** If true, render amounts in parentheses (expense convention). */
  negate?: boolean;
  compare?: StatementLine[];
}) {
  if (lines.length === 0) return null;
  const compareMap = compare ? new Map(compare.map((l) => [l.label, l.amount])) : null;
  const fmt = (v: number) => (v === 0 ? "—" : negate ? `(${formatBdt(v)})` : formatBdt(v));
  return (
    <>
      <tr className="bg-zinc-50 dark:bg-zinc-950">
        <td colSpan={compareMap ? 3 : 2} className="px-4 py-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">
          {title}
        </td>
      </tr>
      {lines.map((l) => (
        <tr key={l.label}>
          <td className="px-4 py-2 pl-8">{l.label}</td>
          <td className="px-4 py-2 text-right tabular-nums">{fmt(l.amount)}</td>
          {compareMap && (
            <td className="px-4 py-2 text-right tabular-nums text-zinc-500">
              {fmt(compareMap.get(l.label) ?? 0)}
            </td>
          )}
        </tr>
      ))}
    </>
  );
}

function SubtotalRow({
  label,
  amount,
  compareAmount,
}: {
  label: string;
  amount: number;
  compareAmount?: number | null;
}) {
  return (
    <tr className="bg-zinc-50/50 dark:bg-zinc-950/50">
      <td className="px-4 py-2 pl-8 text-sm italic text-zinc-600 dark:text-zinc-400">{label}</td>
      <td className="px-4 py-2 text-right font-medium tabular-nums">{formatBdt(amount)}</td>
      {compareAmount != null && (
        <td className="px-4 py-2 text-right font-medium tabular-nums text-zinc-500">
          {formatBdt(compareAmount)}
        </td>
      )}
    </tr>
  );
}

function TotalRow({
  label,
  amount,
  compareAmount,
  emphatic = false,
}: {
  label: string;
  amount: number;
  compareAmount?: number | null;
  emphatic?: boolean;
}) {
  return (
    <tr className={emphatic ? "bg-zinc-900 text-zinc-50 dark:bg-zinc-100 dark:text-zinc-900" : "bg-zinc-100 dark:bg-zinc-800"}>
      <td className="px-4 py-2.5 text-sm font-semibold">{label}</td>
      <td className="px-4 py-2.5 text-right text-sm font-semibold tabular-nums">{formatBdt(amount)}</td>
      {compareAmount != null && (
        <td className="px-4 py-2.5 text-right text-sm font-semibold tabular-nums opacity-70">
          {formatBdt(compareAmount)}
        </td>
      )}
    </tr>
  );
}

function ExternalInputsBanner({ overrides }: { overrides: StatementOverrides }) {
  const hasOverrides = Object.keys(overrides).length > 0;
  if (hasOverrides) {
    return (
      <p className="mt-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
        Using URL-supplied overrides for accountant inputs:{" "}
        {overrides.mgmtFeeTaxAtSource !== undefined && `mgmtFeeTaxAtSource=${overrides.mgmtFeeTaxAtSource} `}
        {overrides.unrealisedFairValueLoss !== undefined && `unrealisedFairValueLoss=${overrides.unrealisedFairValueLoss} `}
        {overrides.fairValueReceivableAdjustment !== undefined && `fairValueReceivableAdjustment=${overrides.fairValueReceivableAdjustment}`}
      </p>
    );
  }
  return (
    <p className="mt-4 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
      Tax provision is auto-derived from TB (capital gain × 15% + dividend × 20%). The mgmt-fee source-tax (Notes (2)!F11) defaults to 0;
      pass <code className="font-mono">?mgmtFeeTax=…</code> to add it, or <code className="font-mono">?fvLoss=…&fvRecv=…</code> for fair-value adjustments.
    </p>
  );
}

function FiscalYearPicker({
  years,
  selectedId,
  overrides,
  compareId,
  compareMode,
}: {
  years: Array<{ id: string; label: string }>;
  selectedId: string;
  overrides: StatementOverrides;
  compareId?: string;
  compareMode: "year" | "period";
}) {
  return (
    <form action="" className="flex flex-wrap items-center gap-2">
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
      <label className="text-xs uppercase tracking-wide text-zinc-500">Compare</label>
      <select
        name="compare"
        defaultValue={compareId ?? ""}
        className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
      >
        <option value="">— none —</option>
        {years.filter((y) => y.id !== selectedId).map((y) => (
          <option key={y.id} value={y.id}>{y.label}</option>
        ))}
      </select>
      <select
        name="cmode"
        defaultValue={compareMode}
        title="Year-wise = full FY P&L. Same period = YTD to the same days-into-FY offset."
        className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
      >
        <option value="year">Year-wise</option>
        <option value="period">Same period</option>
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
