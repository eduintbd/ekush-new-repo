// /admin/tax-provision — three-panel Tax Provision card.
//
// Phase 2: Panels A (Inputs) and B (Computation Preview) are
// functional. Panel C (Actions: Save Rates is live; Post to Ledger /
// Lock Period are stubbed and disabled — they ship in Phase 3).

import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  computeTaxProvision,
  getMgmtFeeTdsFromLedger,
  getProvisionHistory,
  type TaxProvisionResult,
  type SanityCheckResult,
  type ProvisionHistoryRow,
} from "@/lib/tax-provision";
import { formatBdt } from "@/lib/format";
import { saveTaxRates, postTaxProvision } from "./actions";

type Search = {
  fy?: string;
  mgmtFeeAtSource?: string;
  materialityPct?: string;
  carryForward?: string;
  ok?: string;
  error?: string;
};

export const metadata = { title: "Tax Provision — Staff portal" };

const RATE_TYPES = [
  "CAPITAL_GAIN",
  "DIVIDEND",
  "INTEREST",
  "DEFERRED",
  "CORPORATE",
] as const;
const RATE_LABEL: Record<(typeof RATE_TYPES)[number], string> = {
  CAPITAL_GAIN: "Capital Gain",
  DIVIDEND: "Dividend Income",
  INTEREST: "Interest Income (SND / FDR)",
  DEFERRED: "Deferred Tax",
  CORPORATE: "Corporate (Business) Income",
};
const RATE_HELP: Record<(typeof RATE_TYPES)[number], string> = {
  CAPITAL_GAIN: "Applied to net realised capital gain on listed securities.",
  DIVIDEND: "Withheld at source on gross dividend income; treated as final tax.",
  INTEREST:
    "Withheld at source on SND / FDR interest. NOT final for AMC — re-assessed at the corporate rate; TDS is credited as AIT.",
  DEFERRED: "Applied to change in unrealised fair-value gain/loss; offsets DTL.",
  CORPORATE:
    "Regular business income-tax rate applied to total taxable income at AY assessment. Default 27.5% non-listed / 22.5% listed (BD Finance Act).",
};

export default async function TaxProvisionPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  await requireRole(["admin", "checker"]);
  const sp = await searchParams;

  const fiscalYears = await prisma.fiscalYear.findMany({
    orderBy: { startsOn: "desc" },
    select: { id: true, label: true, startsOn: true, endsOn: true, isClosed: true },
  });
  const fy =
    fiscalYears.find((y) => y.id === sp.fy) ?? fiscalYears.find((y) => !y.isClosed) ?? fiscalYears[0];

  // Currently-active rates (one row per type — the most recent
  // effective_from ≤ today). Used to populate Panel A's inputs.
  const allRates = await prisma.taxRate.findMany({
    where: { jurisdiction: "BD" },
    orderBy: [{ rateType: "asc" }, { effectiveFrom: "desc" }],
  });
  const latestRateByType = new Map<string, (typeof allRates)[number]>();
  for (const r of allRates) {
    if (!latestRateByType.has(r.rateType)) latestRateByType.set(r.rateType, r);
  }

  // Overrides from URL. Mgmt-fee TDS defaults to the journal SUMIFS
  // (Source Tax Dr in vouchers also touching Mgmt Fee / Mgmt Fee
  // Accrued, OB excluded) so the admin doesn't have to look it up;
  // typing a different value in Panel A travels via the URL and wins.
  const ledgerTds = fy ? await getMgmtFeeTdsFromLedger(fy.id) : 0;
  const mgmtFeeAtSourceAmount =
    sp.mgmtFeeAtSource !== undefined &&
    sp.mgmtFeeAtSource !== "" &&
    Number.isFinite(Number(sp.mgmtFeeAtSource))
      ? Number(sp.mgmtFeeAtSource)
      : ledgerTds;
  const materialityPctInput = sp.materialityPct ? Number(sp.materialityPct) : 1.0;
  const materialityPct = Number.isFinite(materialityPctInput) ? materialityPctInput / 100 : 0.01;
  const carryForward = sp.carryForward === "1";

  let result: TaxProvisionResult | null = null;
  let computeError: string | null = null;
  let history: ProvisionHistoryRow[] = [];
  if (fy) {
    try {
      result = await computeTaxProvision(fy.id, {
        mgmtFeeAtSourceAmount,
        materialityPct,
        lossCarryForwardEnabled: carryForward,
      });
      history = await getProvisionHistory(fy.id);
    } catch (err) {
      computeError = err instanceof Error ? err.message : String(err);
    }
  }

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10 dark:bg-zinc-950">
      <div className="mx-auto max-w-5xl">
        <Link
          href="/dashboard"
          className="text-xs uppercase tracking-widest text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
        >
          ← Dashboard
        </Link>

        <div className="mt-3 flex items-end justify-between">
          <div>
            <p className="text-xs uppercase tracking-widest text-zinc-500">Admin · Phase 2 of 5</p>
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
              Tax Provision
            </h1>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              Single source of truth for statutory income-tax expense. Reads
              taxable bases from the trial balance, applies statutory rates,
              reconciles to journaled accruals.
            </p>
          </div>
        </div>

        {sp.ok && (
          <p className="mt-4 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-100">
            ✓ {sp.ok}
          </p>
        )}
        {sp.error && (
          <p className="mt-4 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-100">
            ✗ {sp.error}
          </p>
        )}

        {/* Period selector */}
        <form className="mt-6 flex flex-wrap items-end gap-3 rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <label className="block text-xs">
            <span className="font-medium text-zinc-500">Fiscal year</span>
            <select
              name="fy"
              defaultValue={fy?.id ?? ""}
              className="mt-1 block w-44 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            >
              {fiscalYears.map((y) => (
                <option key={y.id} value={y.id}>
                  {y.label}
                  {y.isClosed ? " (closed)" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs">
            <span className="font-medium text-zinc-500">Mgmt-fee TDS (amount)</span>
            <input
              type="number"
              name="mgmtFeeAtSource"
              step="0.01"
              defaultValue={mgmtFeeAtSourceAmount || ""}
              placeholder="0.00"
              className="mt-1 block w-40 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm tabular-nums dark:border-zinc-700 dark:bg-zinc-900"
            />
            {ledgerTds > 0 && (
              <span className="mt-1 block text-[10px] text-zinc-400">
                Default from journal (Source Tax × Mgmt Fee vouchers):{" "}
                ৳{ledgerTds.toLocaleString("en-IN")}
              </span>
            )}
          </label>
          <label className="block text-xs">
            <span className="font-medium text-zinc-500">Materiality (% of PBT)</span>
            <input
              type="number"
              name="materialityPct"
              step="0.1"
              defaultValue={materialityPctInput || 1.0}
              className="mt-1 block w-28 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm tabular-nums dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              name="carryForward"
              value="1"
              defaultChecked={carryForward}
            />
            <span className="text-zinc-700 dark:text-zinc-300">Loss carry-forward enabled</span>
          </label>
          <button className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">
            Recompute
          </button>
        </form>

        {computeError && (
          <p className="mt-4 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-100">
            Compute error: {computeError}
          </p>
        )}

        {result && fy && (
          <>
            {/* Panel A — Inputs */}
            <section className="mt-6 rounded-lg border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
              <header className="mb-4">
                <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
                  Panel A
                </p>
                <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">
                  Statutory rates
                </h2>
                <p className="text-xs text-zinc-500">
                  Each rate row stores its own effective-from date — editing is
                  additive (new row inserted, old rows preserved for audit).
                </p>
              </header>

              <form action={saveTaxRates} className="space-y-2">
                <input type="hidden" name="jurisdiction" value="BD" />
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[10px] uppercase tracking-wider text-zinc-500">
                      <th className="pb-2 font-semibold">Type</th>
                      <th className="pb-2 font-semibold">Rate (%)</th>
                      <th className="pb-2 font-semibold">Effective from</th>
                      <th className="pb-2 font-semibold">Statutory reference</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                    {RATE_TYPES.map((type) => {
                      const existing = latestRateByType.get(type);
                      const currentPct = existing ? Number(existing.value) * 100 : 0;
                      const effFrom = existing
                        ? existing.effectiveFrom.toISOString().slice(0, 10)
                        : "";
                      return (
                        <tr key={type}>
                          <td className="py-2 pr-3 align-top">
                            <input type="hidden" name="rateType" value={type} />
                            <span className="font-medium text-zinc-900 dark:text-zinc-50">
                              {RATE_LABEL[type]}
                            </span>
                            <p className="mt-0.5 text-[11px] text-zinc-500">{RATE_HELP[type]}</p>
                          </td>
                          <td className="py-2 pr-3 align-top">
                            <input
                              type="number"
                              name="valuePct"
                              step="0.01"
                              defaultValue={currentPct.toFixed(2)}
                              className="w-24 rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm tabular-nums dark:border-zinc-700 dark:bg-zinc-900"
                            />
                          </td>
                          <td className="py-2 pr-3 align-top">
                            <input
                              type="date"
                              name="effectiveFrom"
                              defaultValue={effFrom || new Date().toISOString().slice(0, 10)}
                              className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                            />
                          </td>
                          <td className="py-2 pr-3 align-top">
                            <input
                              type="text"
                              name="note"
                              defaultValue={existing?.note ?? ""}
                              placeholder="e.g. BD Finance Act 2024 §53BB"
                              className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <div className="flex items-center gap-2 pt-2">
                  <button
                    type="submit"
                    className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
                  >
                    Save rates
                  </button>
                  <p className="text-[11px] text-zinc-500">
                    A new row is inserted for each rate-type with the chosen effective-from. Existing rows are kept intact.
                  </p>
                </div>
              </form>
            </section>

            {/* Panel B — Computation Preview */}
            <section className="mt-6 rounded-lg border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
              <header className="mb-4 flex flex-wrap items-end justify-between gap-2">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
                    Panel B
                  </p>
                  <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">
                    Computation preview — {result.fiscalYearLabel}
                  </h2>
                  <p className="text-xs text-zinc-500">
                    {result.periodStart.toISOString().slice(0, 10)} →{" "}
                    {result.periodEnd.toISOString().slice(0, 10)} · all source values link to the ledger.
                  </p>
                </div>
                {result.etr !== null && (
                  <div className="text-right">
                    <p className="text-[10px] uppercase tracking-wider text-zinc-500">Effective tax rate</p>
                    <p className="font-mono text-lg font-semibold text-zinc-900 dark:text-zinc-50">
                      {(result.etr * 100).toFixed(2)}%
                    </p>
                  </div>
                )}
              </header>

              {/* Sanity checks */}
              <div className="mb-4 space-y-1.5">
                <SanityRow label="Capital loss within gain" check={result.sanityChecks.capitalLossWithinGain} />
                <SanityRow label="Source-tax credits within expense" check={result.sanityChecks.sourceTaxCreditsWithinExpense} />
                <SanityRow label="Deferred-tax base ties to OCI" check={result.sanityChecks.deferredTaxBaseTiesToOci} />
                <SanityRow label="Reporting period is open" check={result.sanityChecks.periodIsOpen} />
                <SanityRow label="Rates effective ≤ period start" check={result.sanityChecks.ratesEffectiveBeforePeriod} />
              </div>

              {/* Current tax breakdown */}
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">
                Current tax (P&L)
              </h3>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-wider text-zinc-500">
                    <th className="py-1 pr-3 font-semibold">Item</th>
                    <th className="py-1 pr-3 text-right font-semibold">Base</th>
                    <th className="py-1 pr-3 text-right font-semibold">Rate</th>
                    <th className="py-1 pr-3 text-right font-semibold">Tax</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  <TaxRow
                    label="Capital Gain Tax"
                    sourceLink={`/ledger/${encodeURIComponent("Realised Gain/(Loss) on Investments")}?fy=${fy.id}`}
                    base={Math.max(0, result.bases.capitalGainNet)}
                    rate={result.taxRates.CAPITAL_GAIN}
                    tax={result.currentTax.cg}
                    note={
                      !carryForward && result.bases.capitalLoss > result.bases.capitalGainGross
                        ? `Capital loss ${formatBdt(result.bases.capitalLoss - result.bases.capitalGainGross)} unused (floor 0; CF off)`
                        : undefined
                    }
                  />
                  <TaxRow
                    label="Dividend Income Tax"
                    sourceLink={`/ledger/${encodeURIComponent("Dividend Income")}?fy=${fy.id}`}
                    base={result.bases.dividendIncome}
                    rate={result.taxRates.DIVIDEND}
                    tax={result.currentTax.dividend}
                  />
                  <TaxRow
                    label="Interest (net) Tax"
                    sourceLink={`/ledger/${encodeURIComponent("Interest Income")}?fy=${fy.id}`}
                    base={result.bases.interestNetTaxable}
                    rate={result.taxRates.INTEREST}
                    tax={result.currentTax.interest}
                    note={`Net basis: gross ${formatBdt(result.bases.interestIncomeTotal)} − interest expense ${formatBdt(result.bases.interestExpenseTotal)}`}
                  />
                  <TaxRow
                    label="Management Fee TDS"
                    sourceLink={`/ledger/${encodeURIComponent("Management Fee")}?fy=${fy.id}`}
                    base={result.bases.mgmtFeeRevenue}
                    rate={null}
                    tax={result.currentTax.mgmt}
                    note="Final tax until FY 2027-28 — entered as amount withheld at source."
                  />
                  <TaxRow
                    label="Business Income Tax"
                    sourceLink={`/ledger/${encodeURIComponent("Advisory Fee")}?fy=${fy.id}`}
                    base={result.bases.businessNetTaxable}
                    rate={result.taxRates.CORPORATE}
                    tax={result.currentTax.business}
                    note={`Net basis: business income ${formatBdt(result.bases.businessIncomeGross)} (advisory + formation) − G&A ${formatBdt(result.bases.businessExpensesTotal)}`}
                  />
                </tbody>
                <tfoot>
                  <tr className="bg-zinc-50 dark:bg-zinc-950">
                    <td className="py-2 pr-3 text-sm font-semibold">Σ Current Tax</td>
                    <td colSpan={2} />
                    <td className="py-2 pr-3 text-right font-mono text-sm font-semibold tabular-nums">
                      {formatBdt(result.currentTax.total)}
                    </td>
                  </tr>
                </tfoot>
              </table>

              {/* Deferred tax */}
              <h3 className="mt-6 mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">
                Deferred tax (OCI — does not hit P&L)
              </h3>
              <table className="w-full text-sm">
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  <TaxRow
                    label="Change in unrealised fair value"
                    sourceLink="/portfolio"
                    base={result.bases.fairValueChange}
                    rate={result.taxRates.DEFERRED}
                    tax={result.deferredTax}
                    note={
                      result.bases.fairValueChange > 0
                        ? "Gain → debit OCI, credit DTL."
                        : result.bases.fairValueChange < 0
                          ? "Loss → debit DTA, credit OCI."
                          : "No change — no deferred-tax entry."
                    }
                  />
                </tbody>
              </table>

              {/* Reconciliation strip */}
              <div className={`mt-6 rounded-md border px-3 py-3 ${result.reconciliation.isMaterial ? "border-amber-400 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100" : "border-zinc-300 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-950"}`}>
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold uppercase tracking-wider">Reconciliation</span>
                  {result.reconciliation.isMaterial && (
                    <span className="font-medium">
                      ⚠ Variance exceeds materiality ({formatBdt(result.reconciliation.materialityAmount)})
                    </span>
                  )}
                </div>
                <table className="mt-2 w-full text-xs">
                  <tbody>
                    <ReconRow
                      label="Statutory current tax (computed)"
                      amount={result.currentTax.total}
                    />
                    <ReconRow
                      label="Current tax already accrued in journals"
                      amount={result.reconciliation.journaledCurrentTax}
                      sourceLink={`/ledger/${encodeURIComponent("Provision for income tax")}?fy=${fy.id}`}
                    />
                    <ReconRow
                      label="Top-up entry required (current)"
                      amount={result.reconciliation.varianceCurrent}
                      bold
                    />
                    <tr><td colSpan={2} className="py-1" /></tr>
                    <ReconRow
                      label="Statutory deferred tax (computed)"
                      amount={result.deferredTax}
                    />
                    <ReconRow
                      label="Deferred tax already accrued in journals"
                      amount={result.reconciliation.journaledDeferredTax}
                      sourceLink={`/ledger/${encodeURIComponent("Deferred Tax")}?fy=${fy.id}`}
                    />
                    <ReconRow
                      label="Top-up entry required (deferred)"
                      amount={result.reconciliation.varianceDeferred}
                      bold
                    />
                  </tbody>
                </table>
              </div>
            </section>

            {/* Panel C — Actions */}
            <section className="mt-6 rounded-lg border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
              <header className="mb-3">
                <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
                  Panel C · Actions
                </p>
                <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">
                  Post & lock
                </h2>
                <p className="text-xs text-zinc-500">
                  Posting writes a new journal entry dated{" "}
                  {result.periodEnd.toISOString().slice(0, 10)} — never modifies existing journals.
                  Re-posting after a rate change writes only the incremental delta.
                </p>
              </header>
              <div className="flex flex-wrap items-center gap-3">
                <PostForm
                  fy={fy}
                  result={result}
                  mgmtFeeAtSource={mgmtFeeAtSourceAmount}
                  materialityPctInput={materialityPctInput}
                  carryForward={carryForward}
                />
                <span className="text-[11px] text-zinc-500">
                  To lock this period,{" "}
                  <Link href="/admin/fiscal-years" className="underline-offset-2 hover:underline">
                    close the fiscal year
                  </Link>{" "}
                  via the Fiscal years admin.
                </span>
              </div>
            </section>

            {/* Audit-trail history */}
            {history.length > 0 && (
              <section className="mt-6 rounded-lg border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
                <header className="mb-3">
                  <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
                    History · {result.fiscalYearLabel}
                  </p>
                  <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">
                    Past computations
                  </h2>
                  <p className="text-xs text-zinc-500">
                    Latest {history.length} TaxProvision rows. Only the POSTED row is live; SUPERSEDED rows kept for audit.
                  </p>
                </header>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-[10px] uppercase tracking-wider text-zinc-500">
                      <th className="py-1.5 pr-3 font-semibold">Computed at</th>
                      <th className="py-1.5 pr-3 font-semibold">Status</th>
                      <th className="py-1.5 pr-3 text-right font-semibold">Current tax</th>
                      <th className="py-1.5 pr-3 text-right font-semibold">Deferred tax</th>
                      <th className="py-1.5 pr-3 text-right font-semibold">Top-up posted</th>
                      <th className="py-1.5 pr-3 font-semibold">Voucher</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                    {history.map((h) => {
                      const totalTopup = h.postings.reduce((s, p) => s + p.amount, 0);
                      const batchId = h.postings[0]?.journalBatchId;
                      return (
                        <tr key={h.id}>
                          <td className="py-1.5 pr-3 font-mono">
                            {h.computedAt.toISOString().slice(0, 16).replace("T", " ")}
                          </td>
                          <td className="py-1.5 pr-3">
                            <StatusBadge status={h.status} />
                          </td>
                          <td className="py-1.5 pr-3 text-right font-mono tabular-nums">
                            {formatBdt(h.currentTaxTotal)}
                          </td>
                          <td className="py-1.5 pr-3 text-right font-mono tabular-nums">
                            {formatBdt(h.deferredTaxTotal)}
                          </td>
                          <td className="py-1.5 pr-3 text-right font-mono tabular-nums">
                            {h.postings.length === 0 ? "—" : (totalTopup >= 0 ? "+" : "−") + formatBdt(Math.abs(totalTopup))}
                          </td>
                          <td className="py-1.5 pr-3">
                            {batchId ? (
                              <Link
                                href={`/journals/voucher/${batchId}`}
                                className="font-mono text-[11px] underline-offset-2 hover:underline"
                              >
                                {batchId.slice(0, 8)}…
                              </Link>
                            ) : (
                              <span className="text-zinc-400">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </section>
            )}
          </>
        )}
      </div>
    </main>
  );
}

function SanityRow({ label, check }: { label: string; check: SanityCheckResult }) {
  return (
    <div
      className={`flex items-start gap-2 rounded px-2 py-1 text-[12px] ${check.ok ? "text-emerald-700 dark:text-emerald-300" : "text-amber-800 dark:text-amber-300"}`}
    >
      <span className="font-mono">{check.ok ? "✓" : "⚠"}</span>
      <div className="flex-1">
        <span className="font-medium">{label}</span>
        {check.message && (
          <p className="mt-0.5 text-[11px] text-zinc-500">{check.message}</p>
        )}
      </div>
    </div>
  );
}

function TaxRow({
  label,
  sourceLink,
  base,
  rate,
  tax,
  note,
}: {
  label: string;
  sourceLink?: string;
  base: number;
  rate: number | null;
  tax: number;
  note?: string;
}) {
  return (
    <tr>
      <td className="py-1.5 pr-3">
        {sourceLink ? (
          <Link
            href={sourceLink}
            className="underline-offset-2 hover:underline"
          >
            {label}
          </Link>
        ) : (
          label
        )}
        {note && <p className="mt-0.5 text-[10px] text-zinc-500">{note}</p>}
      </td>
      <td className="py-1.5 pr-3 text-right font-mono tabular-nums">{formatBdt(base)}</td>
      <td className="py-1.5 pr-3 text-right font-mono tabular-nums text-zinc-500">
        {rate !== null ? `${(rate * 100).toFixed(2)}%` : "—"}
      </td>
      <td className="py-1.5 pr-3 text-right font-mono tabular-nums">{formatBdt(tax)}</td>
    </tr>
  );
}

function PostForm({
  fy,
  result,
  mgmtFeeAtSource,
  materialityPctInput,
  carryForward,
}: {
  fy: { id: string; label: string; endsOn: Date; isClosed: boolean };
  result: TaxProvisionResult;
  mgmtFeeAtSource: number;
  materialityPctInput: number;
  carryForward: boolean;
}) {
  const cv = result.reconciliation.varianceCurrent;
  const dv = result.reconciliation.varianceDeferred;
  const noTopupNeeded = Math.abs(cv) < 0.005 && Math.abs(dv) < 0.005;
  const parts: string[] = [];
  if (Math.abs(cv) >= 0.005) parts.push(`current ${cv >= 0 ? "+" : "−"}৳${Math.abs(cv).toFixed(2)}`);
  if (Math.abs(dv) >= 0.005) parts.push(`deferred ${dv >= 0 ? "+" : "−"}৳${Math.abs(dv).toFixed(2)}`);
  const confirmMsg = noTopupNeeded
    ? `No top-up needed for ${fy.label} — books already reconcile within ৳0.01. Submit anyway?`
    : `Post top-up journal for ${fy.label}: ${parts.join(", ")}. This writes a new TX-prefixed voucher dated ${fy.endsOn.toISOString().slice(0, 10)} — it does NOT modify existing journals. Continue?`;

  if (fy.isClosed) {
    return (
      <button
        type="button"
        disabled
        className="cursor-not-allowed rounded-md border border-zinc-300 bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-400 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-500"
        title="Fiscal year is closed — reopen via /admin/fiscal-years"
      >
        Post to Ledger (FY closed)
      </button>
    );
  }

  return (
    <form action={postTaxProvision} data-confirm={confirmMsg}>
      <input type="hidden" name="fiscalYearId" value={fy.id} />
      <input type="hidden" name="mgmtFeeAtSourceAmount" value={mgmtFeeAtSource} />
      <input type="hidden" name="materialityPct" value={materialityPctInput} />
      <input type="hidden" name="carryForward" value={carryForward ? "1" : "0"} />
      <button
        type="submit"
        disabled={noTopupNeeded}
        className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
      >
        {noTopupNeeded ? "Books reconciled — nothing to post" : "Post to Ledger"}
      </button>
    </form>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === "POSTED"
      ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
      : status === "SUPERSEDED"
        ? "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
        : "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200";
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${cls}`}>
      {status}
    </span>
  );
}

function ReconRow({
  label,
  amount,
  sourceLink,
  bold = false,
}: {
  label: string;
  amount: number;
  sourceLink?: string;
  bold?: boolean;
}) {
  return (
    <tr className={bold ? "font-semibold" : ""}>
      <td className="py-1 pr-3">
        {sourceLink ? (
          <Link href={sourceLink} className="underline-offset-2 hover:underline">
            {label}
          </Link>
        ) : (
          label
        )}
      </td>
      <td className="py-1 pr-3 text-right font-mono tabular-nums">{formatBdt(amount)}</td>
    </tr>
  );
}
