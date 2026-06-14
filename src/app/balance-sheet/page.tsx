// /balance-sheet — Statement of Financial Position for the selected fiscal
// year (spec §5.11 BS sheet). Mirrors the workbook BS. tab.
//
// Current-tax provision auto-derives from TB; mgmt-fee TDS and fair-value
// receivable adjustment remain accountant inputs. Pass:
//   /balance-sheet?fy=…&mgmtFeeTax=661963&fvRecv=…

import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { formatBdt } from "@/lib/format";
import { getStatements, type StatementOverrides } from "@/lib/statements";
import { diagnoseStatements, type StatementDiagnostics } from "@/lib/statement-diagnostics";
import { requireStaff } from "@/lib/auth";
import type { BalanceSheet, StatementLine } from "@/lib/statement_mapping";
import type { TrialBalanceRow } from "@/lib/trial-balance";
import { PrintButton, PrintSectionButton } from "@/components/print-button";

type Search = {
  fy?: string;
  compare?: string;
  /** "year" (default — compare full FY end-of-period) or "period"
   *  (compare same days-into-FY snapshot). */
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

export default async function BalanceSheetPage({
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

  // For same-period compare, figure out the "as at" cutoff in the
  // current FY (today, clamped to FY range) and in the comparison FY
  // (the same days-into-FY offset, clamped).
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

  // When the BS doesn't balance, run the reconciliation so we can show WHY
  // (no ledger-by-ledger hunt).
  let diag: StatementDiagnostics | null = null;
  if (statements && Math.abs(statements.balanceSheet.totalAssets - statements.balanceSheet.totalEquityAndLiabilities) >= 1) {
    diag = await diagnoseStatements(selectedId, overrides, currentAsOf).catch(() => null);
  }

  return (
    <main className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <div className="mx-auto max-w-4xl px-6 py-10">
        <div className="diag-print-hide flex items-end justify-between gap-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-widest text-zinc-500">
              Staff portal
            </p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
              Balance Sheet
            </h1>
            <p className="mt-1 text-xs text-zinc-500">
              Statement of Financial Position — as at fiscal year end
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
            <div className="diag-print-hide">
              <ExternalInputsBanner overrides={overrides} />
            </div>
            {diag && (
              <ImbalancePanel
                diag={diag}
                fyLabel={
                  currentAsOf
                    ? `${statements.fiscalYear.label} · as at ${currentAsOf.toISOString().slice(0, 10)}`
                    : `${statements.fiscalYear.label} · as at fiscal year end`
                }
              />
            )}
            <div className="diag-print-hide">
              <Report
                bs={statements.balanceSheet}
                tbRows={statements.trialBalance.rows}
                fyLabel={
                  currentAsOf
                    ? `${statements.fiscalYear.label} (as at ${currentAsOf.toISOString().slice(0, 10)})`
                    : statements.fiscalYear.label
                }
                compareBs={compareStatements?.balanceSheet ?? null}
                compareLabel={
                  compareStatements
                    ? compareAsOf
                      ? `${compareStatements.fiscalYear.label} (as at ${compareAsOf.toISOString().slice(0, 10)})`
                      : compareStatements.fiscalYear.label
                    : null
                }
              />
            </div>
          </>
        ) : (
          <p className="mt-10 text-sm text-zinc-500">
            Could not load report — fiscal year may not exist.
          </p>
        )}

        <div className="diag-print-hide mt-8">
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
  bs,
  tbRows,
  fyLabel,
  compareBs,
  compareLabel,
}: {
  bs: BalanceSheet;
  tbRows: TrialBalanceRow[];
  fyLabel: string;
  compareBs: BalanceSheet | null;
  compareLabel: string | null;
}) {
  const diff = bs.totalAssets - bs.totalEquityAndLiabilities;
  const isBalanced = Math.abs(diff) < 1;

  const totals = (sections: StatementLine[]) => sections.reduce((s, l) => s + l.amount, 0);
  const nca = totals(bs.nonCurrentAssets);
  const ca = totals(bs.currentAssets);
  const eq = totals(bs.equity);
  const ncl = totals(bs.nonCurrentLiabilities);
  const cl = totals(bs.currentLiabilities);

  const tbMap = new Map(tbRows.map((r) => [r.accountName, r]));
  const hasCompare = !!compareBs;

  return (
    <div className="mt-8">
      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          {fyLabel}
          {compareLabel && <> · compared with <strong>{compareLabel}</strong></>}
        </p>
        {isBalanced ? (
          <span className="inline-flex items-center rounded-full bg-emerald-100 px-3 py-1 text-xs font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
            ✓ Balanced
          </span>
        ) : (
          <span className="inline-flex items-center rounded-full bg-red-100 px-3 py-1 text-xs font-medium text-red-700 dark:bg-red-950 dark:text-red-300">
            ✗ Out of balance — Assets − E&amp;L = BDT {formatBdt(diff)}
          </span>
        )}
      </div>

      <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <table className="min-w-full table-fixed divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
          <colgroup>
            <col className="w-1/2" />
            <col className={compareBs ? "w-1/4" : "w-1/2"} />
            {compareBs && <col className="w-1/4" />}
          </colgroup>
          {compareBs && (
            <thead className="bg-zinc-50 text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:bg-zinc-950">
              <tr>
                <th className="px-4 py-2 text-left">Item</th>
                <th className="px-4 py-2 text-right">{fyLabel}</th>
                <th className="px-4 py-2 text-right">{compareLabel}</th>
              </tr>
            </thead>
          )}
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            <Section title="Non-Current Assets" lines={bs.nonCurrentAssets} compare={compareBs?.nonCurrentAssets} tbMap={tbMap} hasCompare={hasCompare} />
            <SubtotalRow label="Total Non-Current Assets" amount={nca} compareAmount={compareBs ? totals(compareBs.nonCurrentAssets) : null} />

            <Section title="Current Assets" lines={bs.currentAssets} compare={compareBs?.currentAssets} tbMap={tbMap} hasCompare={hasCompare} />
            <SubtotalRow label="Total Current Assets" amount={ca} compareAmount={compareBs ? totals(compareBs.currentAssets) : null} />

            <TotalRow label="Total Assets" amount={bs.totalAssets} compareAmount={compareBs?.totalAssets ?? null} emphatic />

            <Section title="Equity" lines={bs.equity} compare={compareBs?.equity} tbMap={tbMap} hasCompare={hasCompare} />
            <SubtotalRow label="Total Equity" amount={eq} compareAmount={compareBs ? totals(compareBs.equity) : null} />

            <Section title="Non-Current Liabilities" lines={bs.nonCurrentLiabilities} compare={compareBs?.nonCurrentLiabilities} tbMap={tbMap} hasCompare={hasCompare} />
            <SubtotalRow label="Total Non-Current Liabilities" amount={ncl} compareAmount={compareBs ? totals(compareBs.nonCurrentLiabilities) : null} />

            <Section title="Current Liabilities" lines={bs.currentLiabilities} compare={compareBs?.currentLiabilities} tbMap={tbMap} hasCompare={hasCompare} />
            <SubtotalRow label="Total Current Liabilities" amount={cl} compareAmount={compareBs ? totals(compareBs.currentLiabilities) : null} />

            <TotalRow label="Total Equity & Liabilities" amount={bs.totalEquityAndLiabilities} compareAmount={compareBs?.totalEquityAndLiabilities ?? null} emphatic />
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Section({
  title,
  lines,
  compare,
  tbMap,
  hasCompare,
}: {
  title: string;
  lines: StatementLine[];
  compare?: StatementLine[];
  tbMap: Map<string, TrialBalanceRow>;
  hasCompare: boolean;
}) {
  if (lines.length === 0) return null;
  const compareMap = compare ? new Map(compare.map((l) => [l.label, l.amount])) : null;
  const colSpan = hasCompare ? 3 : 2;
  return (
    <>
      <tr className="bg-zinc-50 dark:bg-zinc-950">
        <td colSpan={colSpan} className="px-4 py-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">
          {title}
        </td>
      </tr>
      {lines.map((l) => (
        <ExpandableLine
          key={l.label}
          line={l}
          compareAmount={compareMap?.get(l.label) ?? null}
          tbMap={tbMap}
          hasCompare={hasCompare}
        />
      ))}
    </>
  );
}

function ExpandableLine({
  line,
  compareAmount,
  tbMap,
  hasCompare,
}: {
  line: StatementLine;
  compareAmount: number | null;
  tbMap: Map<string, TrialBalanceRow>;
  hasCompare: boolean;
}) {
  const expandable = (line.sources?.length ?? 0) > 0;
  const colSpan = hasCompare ? 3 : 2;
  const fmt = (v: number) => (Math.abs(v) < 0.005 ? "—" : formatBdt(v));

  if (!expandable) {
    return (
      <tr>
        <td className="px-4 py-2 pl-8">{line.label}</td>
        <td className="px-4 py-2 text-right tabular-nums">{fmt(line.amount)}</td>
        {hasCompare && (
          <td className="px-4 py-2 text-right tabular-nums text-zinc-500">
            {fmt(compareAmount ?? 0)}
          </td>
        )}
      </tr>
    );
  }

  // Build the per-source breakdown rows from the trial balance.
  const sourceRows = (line.sources ?? []).map((accountName) => {
    const tb = tbMap.get(accountName);
    return {
      accountName,
      grossDebit: tb?.grossDebit ?? 0,
      grossCredit: tb?.grossCredit ?? 0,
      netDebit: tb?.netDebit ?? 0,
      netCredit: tb?.netCredit ?? 0,
    };
  });

  return (
    <tr>
      <td colSpan={colSpan} className="p-0">
        <details className="group block border-b border-transparent open:bg-zinc-50/50 dark:open:bg-zinc-950/30">
          <summary
            className="grid cursor-pointer list-none items-center text-sm [&::-webkit-details-marker]:hidden"
            style={{
              // Mirror the parent table's colgroup ratios so the
              // amount columns inside this summary line up with the
              // real-td amount columns in SubtotalRow / TotalRow.
              gridTemplateColumns: hasCompare ? "2fr 1fr 1fr" : "1fr 1fr",
            }}
          >
            <span className="flex items-center gap-1.5 px-4 py-2 pl-6">
              <span className="inline-block w-3 text-[10px] font-semibold text-zinc-500 transition-transform group-open:rotate-45">
                +
              </span>
              {line.label}
            </span>
            <span className="px-4 py-2 text-right tabular-nums">{fmt(line.amount)}</span>
            {hasCompare && (
              <span className="px-4 py-2 text-right tabular-nums text-zinc-500">
                {fmt(compareAmount ?? 0)}
              </span>
            )}
          </summary>
          <div className="border-t border-zinc-200 bg-zinc-50/70 px-4 py-2 dark:border-zinc-800 dark:bg-zinc-950/50">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-zinc-500">
                  <th className="px-2 py-1 text-left font-medium">Account</th>
                  <th className="px-2 py-1 text-right font-medium">Gross Dr</th>
                  <th className="px-2 py-1 text-right font-medium">Gross Cr</th>
                  <th className="px-2 py-1 text-right font-medium">Net Dr</th>
                  <th className="px-2 py-1 text-right font-medium">Net Cr</th>
                </tr>
              </thead>
              <tbody>
                {sourceRows.map((r) => (
                  <tr key={r.accountName} className="text-zinc-700 dark:text-zinc-300">
                    <td className="px-2 py-1">
                      <Link
                        href={`/ledger/${encodeURIComponent(r.accountName)}`}
                        className="hover:underline"
                      >
                        {r.accountName}
                      </Link>
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums">{fmt(r.grossDebit)}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{fmt(r.grossCredit)}</td>
                    <td className="px-2 py-1 text-right font-medium tabular-nums">{fmt(r.netDebit)}</td>
                    <td className="px-2 py-1 text-right font-medium tabular-nums">{fmt(r.netCredit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </td>
    </tr>
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
      Provision for Income Tax auto-derives from IS. Mgmt-fee TDS and fair-value receivable adj. default to 0;
      pass <code className="font-mono">?mgmtFeeTax=…&fvRecv=…</code> to override.
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
        title="Year-wise = full FY end snapshot. Same period = snapshot at the same days-into-FY offset."
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

// ─── Imbalance diagnostic panel (shown only when the BS doesn't tie) ──
function ImbalancePanel({ diag, fyLabel }: { diag: StatementDiagnostics; fyLabel?: string }) {
  const money = (n: number) => formatBdt(n);
  const droppedAnoms = diag.signAnomalies.filter((a) => a.dropped);
  const harmlessAnoms = diag.signAnomalies.filter((a) => !a.dropped);
  return (
    <div id="diag-panel" className="no-print mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-900 dark:bg-amber-950/30">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold text-amber-900 dark:text-amber-100">
          Why it doesn&apos;t balance — out by {money(diag.bsDiff)} (Assets − Equity &amp; Liabilities)
        </h2>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-amber-800 dark:text-amber-200">
            Trial balance {diag.tbBalanced ? "balances ✓" : `is OFF by ${money(diag.tbDiff)} ✗`}
          </span>
          <PrintSectionButton />
        </div>
      </div>
      {fyLabel && (
        <p className="mt-0.5 text-[11px] font-medium uppercase tracking-wide text-amber-800 dark:text-amber-300">
          Balance Sheet · {fyLabel}
        </p>
      )}
      <p className="mt-1 text-xs text-amber-900/90 dark:text-amber-100/90">{diag.verdict}</p>

      {droppedAnoms.length > 0 && (
        <DiagSection title="Causing the imbalance — dropped from the statements (these sum to the gap; correct the posting or map the account)">
          {droppedAnoms.map((a) => (
            <DiagRow key={a.name} href={`/ledger/${encodeURIComponent(a.name)}`} label={`${a.name} · normal ${a.normalBalance}`} amount={`net-${a.normalBalance === "DEBIT" ? "Cr" : "Dr"} ${money(a.wrongSide)}`} />
          ))}
        </DiagSection>
      )}

      {harmlessAnoms.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-[11px] font-medium uppercase tracking-wider text-amber-800/70 dark:text-amber-300/70">
            {harmlessAnoms.length} wrong-side account(s) read correctly — ChartOfAccount normalBalance flag is mislabelled (harmless, no BS effect)
          </summary>
          <div className="mt-1 divide-y divide-amber-200/60 dark:divide-amber-900/60">
            {harmlessAnoms.map((a) => (
              <DiagRow key={a.name} href={`/ledger/${encodeURIComponent(a.name)}`} label={`${a.name} · normal ${a.normalBalance}`} amount={`net-${a.normalBalance === "DEBIT" ? "Cr" : "Dr"} ${money(a.wrongSide)}`} />
            ))}
          </div>
        </details>
      )}

      {diag.unmappedAccounts.length > 0 && (
        <DiagSection title="Accounts with a balance but on NO statement line (map them in statement_mapping.ts or fix the name)">
          {diag.unmappedAccounts.map((a) => (
            <DiagRow key={a.name} href={`/ledger/${encodeURIComponent(a.name)}`} label={a.name} amount={money(a.signed)} />
          ))}
        </DiagSection>
      )}

      {diag.unclassifiedAccounts.length > 0 && (
        <DiagSection title="Accounts with a balance but no AccountGroup (classify them — Asset/Liability/Equity/Income/Expense)">
          {diag.unclassifiedAccounts.map((a) => (
            <DiagRow key={a.name} href={`/ledger/${encodeURIComponent(a.name)}`} label={a.name} amount={money(a.signed)} />
          ))}
        </DiagSection>
      )}

      {diag.unbalancedVouchers.length > 0 && (
        <DiagSection title="Vouchers that don't individually balance (each Σdebit must equal Σcredit — they net out in the TB but should each balance)">
          {diag.unbalancedVouchers.map((v) => (
            <DiagRow key={v.batchId} href={`/journals/voucher/${v.batchId}`} label={v.voucherNo ?? v.batchId.slice(0, 8)} amount={`Dr ${money(v.debit)} / Cr ${money(v.credit)} · off ${money(v.diff)}`} />
          ))}
        </DiagSection>
      )}

      {diag.externalInputs.length > 0 && (
        <DiagSection title="Non-journaled accountant inputs applied (no GL backing — verify)">
          {diag.externalInputs.map((e) => (
            <DiagRow key={e.label} label={e.label} amount={money(e.amount)} />
          ))}
        </DiagSection>
      )}
    </div>
  );
}

function DiagSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-3">
      <p className="text-[11px] font-medium uppercase tracking-wider text-amber-800 dark:text-amber-300">{title}</p>
      <div className="mt-1 divide-y divide-amber-200/60 dark:divide-amber-900/60">{children}</div>
    </div>
  );
}

function DiagRow({ href, label, amount }: { href?: string; label: string; amount: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1 text-xs">
      {href ? (
        <Link href={href} className="font-mono text-amber-900 underline-offset-2 hover:underline dark:text-amber-100">
          {label}
        </Link>
      ) : (
        <span className="font-mono text-amber-900 dark:text-amber-100">{label}</span>
      )}
      <span className="shrink-0 tabular-nums text-amber-900/90 dark:text-amber-100/90">{amount}</span>
    </div>
  );
}
