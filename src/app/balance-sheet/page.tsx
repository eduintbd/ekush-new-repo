// /balance-sheet — Statement of Financial Position for the selected fiscal
// year (spec §5.11 BS sheet). Mirrors the workbook BS. tab.
//
// External inputs (currentTaxProvision, fairValueReceivableAdjustment) come
// from Notes. (2) + Annexure march which don't have a schema yet (tasks 6 +
// 7). Until then, accept query-string overrides:
//   /balance-sheet?fy=…&taxProvision=1907000&fvRecv=…

import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { formatBdt } from "@/lib/format";
import { getStatements, type StatementOverrides } from "@/lib/statements";
import { requireStaff } from "@/lib/auth";
import type { BalanceSheet, StatementLine } from "@/lib/statement_mapping";

type Search = {
  fy?: string;
  taxProvision?: string;
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
  const tax = Number(sp.taxProvision);
  if (Number.isFinite(tax)) out.currentTaxProvision = tax;
  const loss = Number(sp.fvLoss);
  if (Number.isFinite(loss)) out.unrealisedFairValueLoss = loss;
  const recv = Number(sp.fvRecv);
  if (Number.isFinite(recv)) out.fairValueReceivableAdjustment = recv;
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
  const overrides = parseOverrides(sp);

  let statements;
  try {
    statements = await getStatements(selectedId, overrides);
  } catch {
    statements = null;
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
              Balance Sheet
            </h1>
            <p className="mt-1 text-xs text-zinc-500">
              Statement of Financial Position — as at fiscal year end
            </p>
          </div>
          <FiscalYearPicker
            years={fiscalYears}
            selectedId={selectedId}
            overrides={overrides}
          />
        </div>

        {statements ? (
          <>
            <ExternalInputsBanner overrides={overrides} />
            <Report bs={statements.balanceSheet} fyLabel={statements.fiscalYear.label} />
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

function Report({ bs, fyLabel }: { bs: BalanceSheet; fyLabel: string }) {
  const diff = bs.totalAssets - bs.totalEquityAndLiabilities;
  const isBalanced = Math.abs(diff) < 1;

  const nca = bs.nonCurrentAssets.reduce((s, l) => s + l.amount, 0);
  const ca = bs.currentAssets.reduce((s, l) => s + l.amount, 0);
  const eq = bs.equity.reduce((s, l) => s + l.amount, 0);
  const ncl = bs.nonCurrentLiabilities.reduce((s, l) => s + l.amount, 0);
  const cl = bs.currentLiabilities.reduce((s, l) => s + l.amount, 0);

  return (
    <div className="mt-8">
      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">{fyLabel}</p>
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
        <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            <Section title="Non-Current Assets" lines={bs.nonCurrentAssets} />
            <SubtotalRow label="Total Non-Current Assets" amount={nca} />

            <Section title="Current Assets" lines={bs.currentAssets} />
            <SubtotalRow label="Total Current Assets" amount={ca} />

            <TotalRow label="Total Assets" amount={bs.totalAssets} emphatic />

            <Section title="Equity" lines={bs.equity} />
            <SubtotalRow label="Total Equity" amount={eq} />

            <Section title="Non-Current Liabilities" lines={bs.nonCurrentLiabilities} />
            <SubtotalRow label="Total Non-Current Liabilities" amount={ncl} />

            <Section title="Current Liabilities" lines={bs.currentLiabilities} />
            <SubtotalRow label="Total Current Liabilities" amount={cl} />

            <TotalRow label="Total Equity & Liabilities" amount={bs.totalEquityAndLiabilities} emphatic />
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Section({ title, lines }: { title: string; lines: StatementLine[] }) {
  if (lines.length === 0) return null;
  return (
    <>
      <tr className="bg-zinc-50 dark:bg-zinc-950">
        <td colSpan={2} className="px-4 py-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">
          {title}
        </td>
      </tr>
      {lines.map((l) => (
        <tr key={l.label}>
          <td className="px-4 py-2 pl-8">{l.label}</td>
          <td className="px-4 py-2 text-right tabular-nums">
            {l.amount === 0 ? "—" : formatBdt(l.amount)}
          </td>
        </tr>
      ))}
    </>
  );
}

function SubtotalRow({ label, amount }: { label: string; amount: number }) {
  return (
    <tr className="bg-zinc-50/50 dark:bg-zinc-950/50">
      <td className="px-4 py-2 pl-8 text-sm italic text-zinc-600 dark:text-zinc-400">{label}</td>
      <td className="px-4 py-2 text-right font-medium tabular-nums">{formatBdt(amount)}</td>
    </tr>
  );
}

function TotalRow({
  label,
  amount,
  emphatic = false,
}: {
  label: string;
  amount: number;
  emphatic?: boolean;
}) {
  return (
    <tr className={emphatic ? "bg-zinc-900 text-zinc-50 dark:bg-zinc-100 dark:text-zinc-900" : "bg-zinc-100 dark:bg-zinc-800"}>
      <td className="px-4 py-2.5 text-sm font-semibold">{label}</td>
      <td className="px-4 py-2.5 text-right text-sm font-semibold tabular-nums">{formatBdt(amount)}</td>
    </tr>
  );
}

function ExternalInputsBanner({ overrides }: { overrides: StatementOverrides }) {
  const hasOverrides = Object.keys(overrides).length > 0;
  if (hasOverrides) {
    return (
      <p className="mt-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
        Using URL-supplied overrides for external inputs:{" "}
        {overrides.currentTaxProvision !== undefined && `currentTaxProvision=${overrides.currentTaxProvision} `}
        {overrides.unrealisedFairValueLoss !== undefined && `unrealisedFairValueLoss=${overrides.unrealisedFairValueLoss} `}
        {overrides.fairValueReceivableAdjustment !== undefined && `fairValueReceivableAdjustment=${overrides.fairValueReceivableAdjustment}`}
      </p>
    );
  }
  return (
    <p className="mt-4 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
      External inputs (current-tax provision, fair-value receivable adj.) are stubbed at 0 — Notes (2) + Annexure schema lands with tasks 6 + 7.
      Pass <code className="font-mono">?taxProvision=…&fvRecv=…</code> to preview.
    </p>
  );
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
      {overrides.currentTaxProvision !== undefined && (
        <input type="hidden" name="taxProvision" value={overrides.currentTaxProvision} />
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
