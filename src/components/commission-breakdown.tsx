// The commission breakdown, rendered identically for the admin
// (/admin/agents/[id]) and the selling agent (/agent/earnings). Both read the
// same `computeAgentCommissionPreview` result, so an agent querying their
// commission sees the exact figures the office sees — previously the two
// screens had drifted, and a money display that disagrees with itself becomes
// an argument with an agent.
//
// This file is READ-ONLY by construction: no "use client", no server-action
// imports, no <form>. Every admin mutation reaches the DOM through one of the
// three optional slots, which the agent page simply does not pass.

import type { PreviewResult, UpfrontWatermarkView } from "@/lib/agent-commission-preview";
import { formatBdt } from "@/lib/format";

/**
 * The ONLY fields this component may read. `PreviewResult` also carries
 * `txns`, `termsAll`, `termsActive` and `agentStatus` — internal detail an
 * agent has no business seeing. Narrowing here turns "don't render that" from
 * a thing a reviewer has to remember into a compile error. Callers still pass
 * the whole preview object; excess-property checks don't fire on non-literals.
 */
export type CommissionBreakdownData = Pick<
  PreviewResult,
  | "asOf"
  | "totals"
  | "buckets"
  | "trailRows"
  | "upfrontWatermarks"
  | "upfrontEntitled"
  | "upfrontSuspendedFrom"
>;

export type CommissionAudience = "admin" | "agent";

const COPY: Record<
  CommissionAudience,
  {
    entitlementHint: string;
    watermarkCaption: string;
    trailSummary: (n: number) => string;
    footer: React.ReactNode;
  }
> = {
  admin: {
    entitlementHint:
      "While suspended the monthly run pays no upfront (forfeit — no catch-up). At re-instatement, set each fund's watermark below so no back-dated upfront accrues.",
    watermarkCaption:
      "Upfront = high-water-mark per fund. Paid only on net invested principal (Σ BUY−SELL) rising above the agent's prior peak; the peak never falls when clients redeem.",
    trailSummary: (n) => `Trail commission — quarter-by-quarter (${n} rows)`,
    footer: (
      <>
        Preview is computed live from <code className="font-mono">public.transactions</code> +{" "}
        <code className="font-mono">public.nav_records</code> using the LATEST effective term per
        category. The Excel download contains the same numbers plus a per-transaction breakdown.
        Posting writes rows to <code className="font-mono">xsystem.commission_runs</code> —
        duplicates are skipped via the unique-period index.
      </>
    ),
  },
  agent: {
    entitlementHint:
      "While upfront is suspended no upfront is paid for that period, and it is not paid later in arrears. Trail is unaffected.",
    watermarkCaption:
      "Upfront is paid per fund on new money only — on the amount by which your invested principal rises above its previous peak. Redemptions do not lower that peak, so money that leaves and comes back does not earn upfront twice.",
    trailSummary: (n) => `Trail commission — period by period (${n} rows)`,
    footer: (
      <>
        Figures are computed live from your investors&apos; recorded transactions and the daily NAV
        of each fund, using the commission terms currently in force. Trail accrues each period and
        is paid after the period closes; rows marked partial are still accruing. This is an
        as-of-today estimate for your information, not a statement of account — the amount payable
        is confirmed when the office posts the run.
      </>
    ),
  },
};

export function CommissionBreakdown({
  preview,
  audience,
  entitlementControls,
  watermarkRowAction,
  actionBar,
}: {
  preview: CommissionBreakdownData;
  audience: CommissionAudience;
  /** Admin only: suspend / re-instate forms, rendered inside the entitlement bar. */
  entitlementControls?: React.ReactNode;
  /** Admin only: trailing "Set watermark" cell. Passing it adds the column. */
  watermarkRowAction?: (w: UpfrontWatermarkView) => React.ReactNode;
  /** Admin only: Excel link + Post upfront + Post trail + partial-period note. */
  actionBar?: React.ReactNode;
}) {
  const copy = COPY[audience];
  const isAdmin = audience === "admin";
  // Header and body cells must be gated by the SAME expression or the column
  // counts desync.
  const showRowAction = typeof watermarkRowAction === "function";

  return (
    <>
      {/* Upfront entitlement */}
      <div
        className={`mb-4 rounded-md border p-3 text-xs ${
          preview.upfrontEntitled
            ? "border-zinc-200 dark:border-zinc-800"
            : "border-amber-300 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30"
        }`}
      >
        <div>
          <span className="font-semibold uppercase tracking-wider text-zinc-500">
            Upfront entitlement:{" "}
          </span>
          {preview.upfrontEntitled ? (
            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium uppercase text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
              entitled
            </span>
          ) : (
            <span className="rounded-full bg-amber-200 px-2 py-0.5 text-[10px] font-medium uppercase text-amber-900 dark:bg-amber-900 dark:text-amber-100">
              suspended since {preview.upfrontSuspendedFrom}
            </span>
          )}
          <span className="ml-2 text-[11px] text-zinc-500">{copy.entitlementHint}</span>
        </div>
        {entitlementControls && (
          <div className="mt-2 flex flex-wrap items-end gap-x-5 gap-y-2">{entitlementControls}</div>
        )}
      </div>

      {/* Totals strip */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Stat label="Total inflow" value={formatBdt(preview.totals.inflow)} muted />
        <Stat
          label="Upfront posted"
          value={formatBdt(preview.totals.postedUpfront)}
          muted
          hint={isAdmin ? "watermark upfront already in CommissionRun" : "already posted by the office"}
        />
        <Stat
          label="Upfront pending"
          value={formatBdt(preview.totals.pendingUpfront)}
          hint="new money above the watermark, not yet posted"
        />
        <Stat label="Trail (to date)" value={formatBdt(preview.totals.trail)} />
        <Stat
          label="Total payable"
          value={formatBdt(preview.totals.totalPayable)}
          emphasis
          hint="pending watermark upfront + trail"
        />
      </div>

      {/* Per-fund high-water-mark */}
      {preview.upfrontWatermarks.length > 0 && (
        <div className="mt-4 overflow-x-auto rounded-md border border-zinc-200 dark:border-zinc-800">
          <table className="min-w-full divide-y divide-zinc-200 text-xs dark:divide-zinc-800">
            <caption className="px-3 py-2 text-left text-[11px] text-zinc-500">
              {copy.watermarkCaption}
            </caption>
            <thead className="bg-zinc-50 text-left text-[10px] uppercase tracking-wider text-zinc-500 dark:bg-zinc-950">
              <tr>
                <th className="py-1.5 pr-3 pl-3">Fund</th>
                <th className="py-1.5 pr-3 text-right">Net principal now</th>
                <th className="py-1.5 pr-3 text-right">Watermark (peak)</th>
                <th className="py-1.5 pr-3 text-right">Upfront %</th>
                <th className="py-1.5 pr-3 text-right">Pending new money</th>
                <th className="py-1.5 pr-3 text-right">Pending upfront</th>
                {showRowAction && <th className="py-1.5 pr-3 text-right">Set watermark</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {preview.upfrontWatermarks.map((w) => (
                <tr key={w.fundCode}>
                  <td className="py-1.5 pr-3 pl-3 font-mono">{w.fundCode}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">
                    {formatBdt(w.currentNetPrincipal)}
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">
                    {formatBdt(Math.max(w.storedWatermark, w.peak))}
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">
                    {(w.upfrontPct * 100).toFixed(4)}%
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">
                    {!preview.upfrontEntitled ? (
                      <span className="text-amber-700 dark:text-amber-300">forfeit</span>
                    ) : w.pendingIncrement > 0 ? (
                      formatBdt(w.pendingIncrement)
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="py-1.5 pr-3 text-right font-medium tabular-nums">
                    {preview.upfrontEntitled && w.pendingUpfront > 0
                      ? formatBdt(w.pendingUpfront)
                      : "—"}
                  </td>
                  {showRowAction && (
                    <td className="py-1.5 pr-3">{watermarkRowAction!(w)}</td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {actionBar && <div className="mt-4 flex flex-wrap items-center gap-3">{actionBar}</div>}

      {/* Per-investor breakdown */}
      <div className="mt-5 overflow-x-auto">
        <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
          <thead className="text-left text-[11px] uppercase tracking-wider text-zinc-500">
            <tr>
              <th className="py-2 pr-3">Investor</th>
              <th className="py-2 pr-3">Name</th>
              <th className="py-2 pr-3">Fund</th>
              <th className="py-2 pr-3">Sourced</th>
              <th className="py-2 pr-3 text-right"># Txns</th>
              <th className="py-2 pr-3 text-right">Inflow</th>
              {/* "Initial upfront" is a legacy per-investor reference the live
                  watermark model does not pay on. Kept for admin
                  reconciliation; showing an agent a figure they are not paid
                  on only invites a dispute. */}
              {isAdmin && <th className="py-2 pr-3 text-right">Initial upfront</th>}
              <th className="py-2 pr-3 text-right">Per-inflow upfront</th>
              <th className="py-2 pr-3 text-right">Trail</th>
              <th className="py-2 pr-3 text-right">Payable</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {preview.buckets.map((b) => (
              <tr
                key={`${b.investorCode}|${b.fundCode}`}
                className={b.isDirectSubscription ? "text-zinc-400" : ""}
              >
                <td className="py-1.5 pr-3 font-mono text-xs">{b.investorCode}</td>
                <td className="py-1.5 pr-3">
                  {b.name || <span className="italic text-zinc-400">—</span>}
                  {b.isDirectSubscription && (
                    <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[9px] font-medium uppercase text-amber-800 dark:bg-amber-950 dark:text-amber-200">
                      direct
                    </span>
                  )}
                </td>
                <td className="py-1.5 pr-3 text-xs">{b.fundCode}</td>
                <td className="py-1.5 pr-3 text-xs">{b.sourcedOn.toISOString().slice(0, 10)}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{b.txCount}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{formatBdt(b.inflowTotal)}</td>
                {isAdmin && (
                  <td className="py-1.5 pr-3 text-right tabular-nums">
                    {formatBdt(b.initialUpfront)}
                  </td>
                )}
                <td className="py-1.5 pr-3 text-right tabular-nums">
                  {formatBdt(b.perInflowUpfront)}
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{formatBdt(b.trailTotal)}</td>
                <td className="py-1.5 pr-3 text-right font-semibold tabular-nums">
                  {formatBdt(b.perInflowUpfront + b.trailTotal)}
                </td>
              </tr>
            ))}
            <tr className="border-t-2 border-zinc-300 font-semibold dark:border-zinc-700">
              <td className="py-1.5 pr-3" colSpan={5}>
                TOTAL
              </td>
              <td className="py-1.5 pr-3 text-right tabular-nums">
                {formatBdt(preview.totals.inflow)}
              </td>
              {isAdmin && (
                <td className="py-1.5 pr-3 text-right tabular-nums">
                  {formatBdt(preview.totals.initialUpfront)}
                </td>
              )}
              <td className="py-1.5 pr-3 text-right tabular-nums">
                {formatBdt(preview.totals.perInflowUpfront)}
              </td>
              <td className="py-1.5 pr-3 text-right tabular-nums">
                {formatBdt(preview.totals.trail)}
              </td>
              <td className="py-1.5 pr-3 text-right tabular-nums">
                {formatBdt(preview.totals.totalPayable)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Trail per-period detail */}
      {preview.trailRows.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-zinc-500">
            {copy.trailSummary(preview.trailRows.length)}
          </summary>
          <div className="mt-2 overflow-x-auto">
            <table className="min-w-full divide-y divide-zinc-200 text-xs dark:divide-zinc-800">
              <thead className="text-left text-[10px] uppercase tracking-wider text-zinc-500">
                <tr>
                  <th className="py-1.5 pr-3">Investor</th>
                  <th className="py-1.5 pr-3">Fund</th>
                  <th className="py-1.5 pr-3">{isAdmin ? "Quarter" : "Period"}</th>
                  <th className="py-1.5 pr-3">Tier</th>
                  <th className="py-1.5 pr-3 text-right">Rate p.a.</th>
                  <th className="py-1.5 pr-3 text-right"># NAV</th>
                  <th className="py-1.5 pr-3 text-right">Avg value</th>
                  <th className="py-1.5 pr-3 text-right">Trail</th>
                  <th className="py-1.5 pr-3">Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {preview.trailRows.map((r, i) => (
                  <tr key={i}>
                    <td className="py-1 pr-3 font-mono">{r.investorCode}</td>
                    <td className="py-1 pr-3">{r.fundCode}</td>
                    <td className="py-1 pr-3 font-mono text-[10px]">
                      {r.quarterStart.toISOString().slice(0, 10)} →{" "}
                      {r.quarterEnd.toISOString().slice(0, 10)}
                    </td>
                    <td className="py-1 pr-3">{r.tier}</td>
                    <td className="py-1 pr-3 text-right tabular-nums">
                      {(r.ratePa * 100).toFixed(4)}%
                    </td>
                    <td className="py-1 pr-3 text-right tabular-nums">{r.navPoints}</td>
                    <td className="py-1 pr-3 text-right tabular-nums">{formatBdt(r.avgValue)}</td>
                    <td className="py-1 pr-3 text-right font-semibold tabular-nums">
                      {formatBdt(r.trail)}
                    </td>
                    <td className="py-1 pr-3 text-[10px] text-amber-700 dark:text-amber-300">
                      {r.partial ? "partial — not posted yet" : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      <p className="mt-3 text-[10px] text-zinc-500">{copy.footer}</p>
    </>
  );
}

export function Stat({
  label,
  value,
  hint,
  emphasis = false,
  muted = false,
}: {
  label: string;
  value: string;
  hint?: string;
  emphasis?: boolean;
  muted?: boolean;
}) {
  return (
    <div
      className={`rounded-md border p-3 ${
        emphasis
          ? "border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950"
          : muted
            ? "border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950"
            : "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"
      }`}
    >
      <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">{label}</p>
      <p
        className={`mt-0.5 font-mono tabular-nums ${
          emphasis ? "text-lg font-bold text-emerald-800 dark:text-emerald-200" : "text-base"
        }`}
      >
        {value}
      </p>
      {hint && <p className="mt-0.5 text-[10px] text-zinc-500">{hint}</p>}
    </div>
  );
}
