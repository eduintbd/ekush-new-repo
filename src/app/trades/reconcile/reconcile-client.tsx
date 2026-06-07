"use client";

// Drives the reconcile flow: upload broker/fund statements → review the
// extracted trades → reconcile against x-system → report. Each report row
// deep-links into the editable-trades feature so the accountant fixes it
// in one click. Download Excel (POSTs findings to the export route) or
// Print → Save as PDF (uses the app's print CSS).

import { useActionState, useState } from "react";
import Link from "next/link";
import { reconcileFlow, type ReconcileState } from "./actions";
import type { Finding, FindingCategory } from "@/lib/reconcile-ledger";

const CAT_LABEL: Record<FindingCategory, string> = {
  missing: "Missing — journal not entered",
  mismatch: "Wrongly entered — values differ",
  date_shift: "Mis-dated",
  extra: "Extra — not on any statement",
  desync: "Trade ↔ journal out of sync",
  holding: "Holdings / opening-balance differs",
};
const CAT_ORDER: FindingCategory[] = ["missing", "mismatch", "date_shift", "desync", "extra", "holding"];
const CAT_TONE: Record<FindingCategory, string> = {
  missing: "text-red-700 dark:text-red-300",
  mismatch: "text-amber-700 dark:text-amber-300",
  date_shift: "text-amber-700 dark:text-amber-300",
  desync: "text-fuchsia-700 dark:text-fuchsia-300",
  extra: "text-sky-700 dark:text-sky-300",
  holding: "text-zinc-700 dark:text-zinc-300",
};

export function ReconcileClient({ fiscalYears, defaultFyId }: { fiscalYears: { id: string; label: string }[]; defaultFyId: string }) {
  const [state, formAction, pending] = useActionState<ReconcileState, FormData>(reconcileFlow, { phase: "idle" });

  return (
    <div className="mt-8 space-y-6">
      {(state.phase === "idle" || state.phase === "error") && <UploadForm formAction={formAction} pending={pending} error={state.phase === "error" ? state.message : undefined} />}
      {state.phase === "review" && <ReviewStep state={state} formAction={formAction} pending={pending} fiscalYears={fiscalYears} defaultFyId={defaultFyId} />}
      {state.phase === "report" && <ReportStep state={state} formAction={formAction} />}
    </div>
  );
}

function UploadForm({ formAction, pending, error }: { formAction: (fd: FormData) => void; pending: boolean; error?: string }) {
  return (
    <form action={formAction} className="rounded-lg border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <input type="hidden" name="phase" value="parse" />
      <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">Upload statements</h2>
      <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
        Broker ledger PDFs (UCB / Prime / Abaci), the Prime portfolio PDF (for the holdings check), and the fund-subscription CSV
        (EFUF/EGF/ESRF). Select all that apply — they&apos;re reconciled together.
      </p>
      {error && <p className="mt-3 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">{error}</p>}
      <input
        type="file"
        name="files"
        multiple
        accept=".pdf,.csv"
        className="mt-4 block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-zinc-900 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white dark:file:bg-zinc-100 dark:file:text-zinc-900"
      />
      <button disabled={pending} className="mt-4 rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900">
        {pending ? "Parsing…" : "Parse statements"}
      </button>
    </form>
  );
}

function ReviewStep({
  state,
  formAction,
  pending,
  fiscalYears,
  defaultFyId,
}: {
  state: Extract<ReconcileState, { phase: "review" }>;
  formAction: (fd: FormData) => void;
  pending: boolean;
  fiscalYears: { id: string; label: string }[];
  defaultFyId: string;
}) {
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const toggle = (i: number) =>
    setExcluded((prev) => {
      const next = new Set(prev);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });
  const keptRows = state.rows.filter((_, i) => !excluded.has(i));

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-zinc-200 bg-white p-4 text-xs shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <span className="font-semibold uppercase tracking-wider text-zinc-500">Parsed</span>
        <ul className="mt-2 space-y-0.5">
          {state.files.map((f, i) => (
            <li key={i} className="text-zinc-600 dark:text-zinc-400">
              <span className="font-mono">{f.name}</span> → {f.profile} · <span className="font-mono">{f.source}</span> · {f.rows} trades{f.holdings ? `, ${f.holdings} holdings` : ""}
            </li>
          ))}
        </ul>
        {state.warnings.length > 0 && (
          <div className="mt-3 rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
            {state.warnings.slice(0, 8).map((w, i) => (
              <div key={i}>⚠ {w}</div>
            ))}
            {state.warnings.length > 8 && <div>…and {state.warnings.length - 8} more</div>}
          </div>
        )}
      </div>

      <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <table className="min-w-full divide-y divide-zinc-200 text-xs dark:divide-zinc-800">
          <thead className="bg-zinc-50 dark:bg-zinc-950">
            <tr className="text-left uppercase tracking-wider text-zinc-500">
              <th className="px-3 py-2">Keep</th>
              <th className="px-3 py-2">Date</th>
              <th className="px-3 py-2">Instrument</th>
              <th className="px-3 py-2">Side</th>
              <th className="px-3 py-2 text-right">Qty</th>
              <th className="px-3 py-2 text-right">Rate</th>
              <th className="px-3 py-2 text-right">Gross</th>
              <th className="px-3 py-2 text-right">Comm</th>
              <th className="px-3 py-2">Source</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {state.rows.map((r, i) => (
              <tr key={i} className={excluded.has(i) ? "opacity-40" : ""}>
                <td className="px-3 py-1.5"><input type="checkbox" checked={!excluded.has(i)} onChange={() => toggle(i)} /></td>
                <td className="px-3 py-1.5 font-mono">{r.date}</td>
                <td className="px-3 py-1.5 font-mono">{r.instrumentCode ?? <span className="text-red-600">?{r.rawInstrument}</span>}</td>
                <td className="px-3 py-1.5">{r.side}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{r.quantity.toLocaleString("en-IN")}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{r.rate}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{r.grossAmount.toLocaleString("en-IN")}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{r.commission || "—"}</td>
                <td className="px-3 py-1.5 text-zinc-500">{r.source}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <form action={formAction} className="flex flex-wrap items-end gap-3 rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <input type="hidden" name="phase" value="reconcile" />
        <input type="hidden" name="rowsJson" value={JSON.stringify(keptRows)} />
        <input type="hidden" name="holdingsJson" value={JSON.stringify(state.holdings)} />
        <label className="block text-xs">
          <span className="font-medium uppercase tracking-wider text-zinc-500">Fiscal year</span>
          <select name="fiscalYearId" defaultValue={defaultFyId} className="mt-1 block rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900">
            {fiscalYears.map((y) => (
              <option key={y.id} value={y.id}>{y.label}</option>
            ))}
          </select>
        </label>
        <button disabled={pending} className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900">
          {pending ? "Reconciling…" : `Reconcile ${keptRows.length} trades →`}
        </button>
      </form>
    </div>
  );
}

function ReportStep({ state, formAction }: { state: Extract<ReconcileState, { phase: "report" }>; formAction: (fd: FormData) => void }) {
  const { result, fyLabel } = state;
  const byCat = (c: FindingCategory) => result.findings.filter((f) => f.category === c);
  const total = result.findings.length;

  return (
    <div className="space-y-5">
      <div className="no-print flex flex-wrap gap-2">
        <form action="/api/exports/reconcile/xlsx" method="post">
          <input type="hidden" name="payload" value={JSON.stringify({ fyLabel, summary: result.summary, findings: result.findings })} />
          <button className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800">⬇ Excel</button>
        </form>
        <button onClick={() => window.print()} className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800">🖨 Print / PDF</button>
        <form action={formAction}>
          <input type="hidden" name="phase" value="parse" />
          <button className="rounded-md px-3 py-1.5 text-sm text-zinc-500 underline hover:text-zinc-700">Start over</button>
        </form>
      </div>

      <div className="print-area space-y-5">
        <div>
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">Reconciliation — {fyLabel}</h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            {result.summary.matched} matched · {total} to review across {result.summary.ledgerRows} ledger trades vs {result.summary.dbTrades} x-system trades.
          </p>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
            {CAT_ORDER.map((c) => (
              <span key={c} className={CAT_TONE[c]}>{CAT_LABEL[c]}: <strong>{result.summary[c]}</strong></span>
            ))}
          </div>
        </div>

        {total === 0 ? (
          <p className="rounded-md border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">
            ✓ Every ledger trade reconciles with x-system. No missing or wrong journals.
          </p>
        ) : (
          CAT_ORDER.filter((c) => byCat(c).length > 0).map((c) => (
            <section key={c}>
              <h3 className={`text-xs font-semibold uppercase tracking-wider ${CAT_TONE[c]}`}>{CAT_LABEL[c]} ({byCat(c).length})</h3>
              <div className="mt-2 overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
                <table className="min-w-full divide-y divide-zinc-200 text-xs dark:divide-zinc-800">
                  <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                    {byCat(c).map((f, i) => (
                      <FindingRow key={i} f={f} />
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))
        )}
      </div>
    </div>
  );
}

function FindingRow({ f }: { f: Finding }) {
  return (
    <tr>
      <td className="px-3 py-1.5 font-mono whitespace-nowrap">{f.date ?? "—"}</td>
      <td className="px-3 py-1.5 font-mono whitespace-nowrap">{f.instrumentCode ?? "—"}{f.side ? ` ${f.side}` : ""}</td>
      <td className="px-3 py-1.5 text-zinc-700 dark:text-zinc-300">{f.detail}</td>
      <td className="px-3 py-1.5 text-right no-print whitespace-nowrap">
        {f.fixHref && (
          <Link href={f.fixHref} className="rounded border border-zinc-300 px-2 py-0.5 font-medium uppercase tracking-wider text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800">
            {f.category === "missing" ? "Add" : "Fix"}
          </Link>
        )}
      </td>
    </tr>
  );
}
