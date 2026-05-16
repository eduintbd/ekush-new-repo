// /annexures — Annexure-A (PPE register) + Annexure-B (Investments) per
// spec §5.11. Annexure-A pulls from FixedAsset + FixedAssetDepreciation;
// Annexure-B mirrors the workbook's "Annexure march" sheet (per-instrument
// holdings grouped by category). The total unrealised G/L on B flows into
// IS OCI (Note 24) automatically via getStatements.

import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { formatBdt } from "@/lib/format";
import { PrintButton } from "@/components/print-button";
import {
  getAnnexureA,
  getAnnexureB,
  type AnnexureAGroup,
  type AnnexureGroup,
} from "@/lib/annexures";
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

export default async function AnnexuresPage({
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
  const fyLabel = fiscalYears.find((y) => y.id === selectedId)?.label ?? "";

  let annexureA, annexureB;
  try {
    [annexureA, annexureB] = await Promise.all([
      getAnnexureA(selectedId),
      getAnnexureB(selectedId),
    ]);
  } catch {
    annexureA = null;
    annexureB = null;
  }

  return (
    <main className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <div className="mx-auto max-w-6xl px-6 py-10">
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-widest text-zinc-500">
              Staff portal
            </p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
              Annexures
            </h1>
            <p className="mt-1 text-xs text-zinc-500">
              Annexure-B: Investments (per instrument)
            </p>
          </div>
          <div className="no-print flex flex-wrap items-center gap-2">
            <FiscalYearPicker years={fiscalYears} selectedId={selectedId} />
            <PrintButton />
          </div>
        </div>

        {annexureA ? (
          <AnnexureASection groups={annexureA.groups} totals={annexureA.totals} fyLabel={fyLabel} />
        ) : (
          <p className="mt-8 text-sm text-zinc-500">
            Could not load Annexure-A — FixedAsset table may not exist yet.
          </p>
        )}

        {annexureB ? (
          <AnnexureBSection
            asOfDate={annexureB.asOfDate}
            groups={annexureB.groups}
            totals={annexureB.totals}
            fyLabel={fyLabel}
          />
        ) : (
          <p className="mt-10 text-sm text-zinc-500">
            Could not load Annexure-B — fiscal year may not exist.
          </p>
        )}

        <div className="mt-12">
          <Link href="/dashboard" className="text-sm text-zinc-600 underline dark:text-zinc-400">
            ← Back to dashboard
          </Link>
        </div>
      </div>
    </main>
  );
}

// ─── Annexure-A (PPE register) ────────────────────────────────────

function AnnexureASection({
  groups,
  totals,
  fyLabel,
}: {
  groups: AnnexureAGroup[];
  totals: { cost: number; accumulatedDepreciation: number; periodDepreciation: number; wdv: number };
  fyLabel: string;
}) {
  const isEmpty = groups.every((g) => g.rows.length === 0);

  return (
    <section className="mt-8 rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <header className="flex items-center justify-between border-b border-zinc-200 bg-zinc-50 px-5 py-3 dark:border-zinc-800 dark:bg-zinc-950">
        <div>
          <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">
            Annexure-A: Property, Plant and Equipment
          </h2>
          <p className="mt-0.5 text-xs text-zinc-500">{fyLabel}</p>
        </div>
        {!isEmpty && (
          <span className="inline-flex items-center rounded-full bg-zinc-100 px-3 py-1 text-xs font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
            WDV: BDT {formatBdt(totals.wdv)}
          </span>
        )}
      </header>

      {isEmpty ? (
        <div className="px-5 py-10 text-center text-sm text-zinc-500">
          No fixed-asset rows recorded yet. Assets are entered via Prisma
          Studio (<code className="font-mono">npm run db:studio</code>) or
          seeded into the <code className="font-mono">fixed_assets</code> table;
          per-FY depreciation goes into <code className="font-mono">fixed_asset_depreciations</code>.
          Once populated, totals feed Notes 4 (PPE) and 22 (Depreciation) automatically.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
            <thead className="bg-zinc-50 text-[11px] uppercase tracking-wider text-zinc-500 dark:bg-zinc-950">
              <tr>
                <th className="px-4 py-2 text-left font-semibold">Asset</th>
                <th className="px-4 py-2 text-left font-semibold">Acquired</th>
                <th className="px-4 py-2 text-right font-semibold">Rate %/pa</th>
                <th className="px-4 py-2 text-right font-semibold">Cost</th>
                <th className="px-4 py-2 text-right font-semibold">Accumulated Depr.</th>
                <th className="px-4 py-2 text-right font-semibold">Charged this FY</th>
                <th className="px-4 py-2 text-right font-semibold">WDV</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {groups.map((g) =>
                g.rows.length === 0 ? null : <AssetGroupRows key={g.assetClass} group={g} />,
              )}
            </tbody>
            <tfoot className="bg-zinc-900 text-zinc-50 dark:bg-zinc-100 dark:text-zinc-900">
              <tr className="font-semibold">
                <td className="px-4 py-2.5">Grand Total</td>
                <td />
                <td />
                <td className="px-4 py-2.5 text-right tabular-nums">{formatBdt(totals.cost)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{formatBdt(totals.accumulatedDepreciation)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{formatBdt(totals.periodDepreciation)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{formatBdt(totals.wdv)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}

function AssetGroupRows({ group }: { group: AnnexureAGroup }) {
  return (
    <>
      <tr className="bg-zinc-50/60 dark:bg-zinc-950/60">
        <td colSpan={7} className="px-4 py-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">
          {group.label}
        </td>
      </tr>
      {group.rows.map((r) => (
        <tr key={r.id}>
          <td className="px-4 py-2 pl-8">
            {r.name}
            {r.disposedOn && (
              <span className="ml-2 inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                disposed {r.disposedOn.toISOString().slice(0, 10)}
              </span>
            )}
          </td>
          <td className="px-4 py-2 text-xs text-zinc-500">{r.acquiredOn.toISOString().slice(0, 10)}</td>
          <td className="px-4 py-2 text-right tabular-nums">
            {r.depreciationRatePctPa === null ? "—" : `${r.depreciationRatePctPa.toFixed(2)}%`}
          </td>
          <td className="px-4 py-2 text-right tabular-nums">{formatBdt(r.cost)}</td>
          <td className="px-4 py-2 text-right tabular-nums">{formatBdt(r.accumulatedDepreciation)}</td>
          <td className="px-4 py-2 text-right tabular-nums">
            {r.periodDepreciation === 0 ? "—" : formatBdt(r.periodDepreciation)}
          </td>
          <td className="px-4 py-2 text-right tabular-nums">{formatBdt(r.wdv)}</td>
        </tr>
      ))}
      <tr className="bg-zinc-50/50 dark:bg-zinc-950/50">
        <td className="px-4 py-2 pl-8 text-sm italic text-zinc-600 dark:text-zinc-400">
          Subtotal — {group.label}
        </td>
        <td />
        <td />
        <td className="px-4 py-2 text-right font-medium tabular-nums">{formatBdt(group.subtotals.cost)}</td>
        <td className="px-4 py-2 text-right font-medium tabular-nums">{formatBdt(group.subtotals.accumulatedDepreciation)}</td>
        <td className="px-4 py-2 text-right font-medium tabular-nums">
          {group.subtotals.periodDepreciation === 0 ? "—" : formatBdt(group.subtotals.periodDepreciation)}
        </td>
        <td className="px-4 py-2 text-right font-medium tabular-nums">{formatBdt(group.subtotals.wdv)}</td>
      </tr>
    </>
  );
}

// ─── Annexure-B (Investments) ─────────────────────────────────────

function AnnexureBSection({
  asOfDate,
  groups,
  totals,
  fyLabel,
}: {
  asOfDate: Date | null;
  groups: AnnexureGroup[];
  totals: { totalCost: number; marketValue: number; unrealisedGain: number };
  fyLabel: string;
}) {
  const isEmpty = groups.every((g) => g.rows.length === 0);

  return (
    <section className="mt-8 rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <header className="flex items-center justify-between border-b border-zinc-200 bg-zinc-50 px-5 py-3 dark:border-zinc-800 dark:bg-zinc-950">
        <div>
          <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">
            Annexure-B: Investments
          </h2>
          <p className="mt-0.5 text-xs text-zinc-500">
            {fyLabel}
            {asOfDate && ` — as at ${asOfDate.toISOString().slice(0, 10)}`}
          </p>
        </div>
        <UnrealisedBadge total={totals.unrealisedGain} />
      </header>

      {isEmpty ? (
        <div className="px-5 py-10 text-center text-sm text-zinc-500">
          No investment holdings recorded for this fiscal year yet.
          Holdings are entered via Prisma Studio (<code className="font-mono">npm run db:studio</code>) or seeded into
          the <code className="font-mono">investment_holdings</code> table. Sum of unrealised loss
          feeds IS OCI (Note 24) automatically once populated.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
            <thead className="bg-zinc-50 text-[11px] uppercase tracking-wider text-zinc-500 dark:bg-zinc-950">
              <tr>
                <th className="px-4 py-2 text-left font-semibold">Instrument</th>
                <th className="px-4 py-2 text-right font-semibold">Quantity</th>
                <th className="px-4 py-2 text-right font-semibold">Avg Cost (Q.)</th>
                <th className="px-4 py-2 text-right font-semibold">Total Cost</th>
                <th className="px-4 py-2 text-right font-semibold">Market Rate (Q.)</th>
                <th className="px-4 py-2 text-right font-semibold">Market Value</th>
                <th className="px-4 py-2 text-right font-semibold">Unrealised G/(L)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {groups.map((g) =>
                g.rows.length === 0 ? null : (
                  <GroupRows key={g.category} group={g} />
                ),
              )}
            </tbody>
            <tfoot className="bg-zinc-900 text-zinc-50 dark:bg-zinc-100 dark:text-zinc-900">
              <tr className="font-semibold">
                <td className="px-4 py-2.5">Grand Total</td>
                <td />
                <td />
                <td className="px-4 py-2.5 text-right tabular-nums">{formatBdt(totals.totalCost)}</td>
                <td />
                <td className="px-4 py-2.5 text-right tabular-nums">{formatBdt(totals.marketValue)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{formatBdt(totals.unrealisedGain)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}

function GroupRows({ group }: { group: AnnexureGroup }) {
  return (
    <>
      <tr className="bg-zinc-50/60 dark:bg-zinc-950/60">
        <td colSpan={7} className="px-4 py-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">
          {group.label}
        </td>
      </tr>
      {group.rows.map((r) => (
        <tr key={r.id}>
          <td className="px-4 py-2 pl-8">{r.instrumentName}</td>
          <td className="px-4 py-2 text-right tabular-nums">
            {r.quantity.toLocaleString("en-IN", { maximumFractionDigits: 4 })}
          </td>
          <td className="px-4 py-2 text-right tabular-nums">{formatBdt(r.avgCostPerUnit)}</td>
          <td className="px-4 py-2 text-right tabular-nums">{formatBdt(r.totalCost)}</td>
          <td className="px-4 py-2 text-right tabular-nums">
            {r.marketRatePerUnit === null ? "—" : formatBdt(r.marketRatePerUnit)}
          </td>
          <td className="px-4 py-2 text-right tabular-nums">
            {r.marketValue === null ? "—" : formatBdt(r.marketValue)}
          </td>
          <td className={`px-4 py-2 text-right tabular-nums ${r.unrealisedGain !== null && r.unrealisedGain < 0 ? "text-red-600 dark:text-red-400" : ""}`}>
            {r.unrealisedGain === null ? "—" : formatBdt(r.unrealisedGain)}
          </td>
        </tr>
      ))}
      <tr className="bg-zinc-50/50 dark:bg-zinc-950/50">
        <td className="px-4 py-2 pl-8 text-sm italic text-zinc-600 dark:text-zinc-400">
          Subtotal — {group.label}
        </td>
        <td />
        <td />
        <td className="px-4 py-2 text-right font-medium tabular-nums">{formatBdt(group.subtotals.totalCost)}</td>
        <td />
        <td className="px-4 py-2 text-right font-medium tabular-nums">{formatBdt(group.subtotals.marketValue)}</td>
        <td className={`px-4 py-2 text-right font-medium tabular-nums ${group.subtotals.unrealisedGain < 0 ? "text-red-600 dark:text-red-400" : ""}`}>
          {formatBdt(group.subtotals.unrealisedGain)}
        </td>
      </tr>
    </>
  );
}

function UnrealisedBadge({ total }: { total: number }) {
  if (total === 0) {
    return (
      <span className="inline-flex items-center rounded-full bg-zinc-100 px-3 py-1 text-xs font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
        No unrealised G/L
      </span>
    );
  }
  const isLoss = total < 0;
  return (
    <span
      className={
        isLoss
          ? "inline-flex items-center rounded-full bg-red-100 px-3 py-1 text-xs font-medium text-red-700 dark:bg-red-950 dark:text-red-300"
          : "inline-flex items-center rounded-full bg-emerald-100 px-3 py-1 text-xs font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
      }
    >
      {isLoss ? "↓" : "↑"} Unrealised {isLoss ? "loss" : "gain"}: BDT {formatBdt(total)}
    </span>
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
