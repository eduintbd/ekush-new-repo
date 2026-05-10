"use client";

// Client component that owns the dynamic line list + live Σ totals.
// Submit stays disabled until Σ debit === Σ credit and at least 2 lines.

import { useMemo, useState } from "react";

type Line = { id: number; account: string; debit: string; credit: string };

let nextId = 0;

export function JournalLines({ accounts }: { accounts: string[] }) {
  const [lines, setLines] = useState<Line[]>(() => [
    { id: ++nextId, account: "", debit: "", credit: "" },
    { id: ++nextId, account: "", debit: "", credit: "" },
  ]);

  const totals = useMemo(() => {
    let d = 0, c = 0;
    for (const l of lines) {
      d += Number(l.debit || 0);
      c += Number(l.credit || 0);
    }
    return { d, c, balanced: Math.abs(d - c) < 0.005 && d > 0 };
  }, [lines]);

  const addLine = () =>
    setLines((ls) => [...ls, { id: ++nextId, account: "", debit: "", credit: "" }]);
  const removeLine = (id: number) =>
    setLines((ls) => (ls.length > 2 ? ls.filter((l) => l.id !== id) : ls));
  const update = (id: number, key: keyof Line, value: string) =>
    setLines((ls) => ls.map((l) => (l.id === id ? { ...l, [key]: value } : l)));

  const fmt = (n: number) =>
    n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <div className="mt-6 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <p className="mb-3 text-xs font-medium uppercase tracking-wider text-zinc-600 dark:text-zinc-400">
        Lines
      </p>
      <div className="space-y-2">
        {lines.map((line, idx) => (
          <div key={line.id} className="grid grid-cols-12 items-center gap-2">
            <input
              list="account-options"
              name="account"
              required
              value={line.account}
              onChange={(e) => update(line.id, "account", e.target.value)}
              placeholder={`Account ${idx + 1}`}
              className="col-span-6 rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
            />
            <input
              name="debit"
              type="number"
              min="0"
              step="0.01"
              value={line.debit}
              onChange={(e) => update(line.id, "debit", e.target.value)}
              placeholder="Debit"
              className="col-span-2 rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-right text-sm tabular-nums dark:border-zinc-700 dark:bg-zinc-950"
            />
            <input
              name="credit"
              type="number"
              min="0"
              step="0.01"
              value={line.credit}
              onChange={(e) => update(line.id, "credit", e.target.value)}
              placeholder="Credit"
              className="col-span-2 rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-right text-sm tabular-nums dark:border-zinc-700 dark:bg-zinc-950"
            />
            <button
              type="button"
              onClick={() => removeLine(line.id)}
              disabled={lines.length <= 2}
              className="col-span-2 rounded-md border border-zinc-300 px-2 py-1.5 text-xs text-zinc-600 hover:bg-zinc-100 disabled:opacity-30 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              Remove
            </button>
          </div>
        ))}
      </div>

      <datalist id="account-options">
        {accounts.map((a) => <option key={a} value={a} />)}
      </datalist>

      <div className="mt-3 flex items-center justify-between">
        <button
          type="button"
          onClick={addLine}
          className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          + Add line
        </button>
        <div className="text-xs">
          <span className="text-zinc-500">Σ debit: </span>
          <span className="font-medium tabular-nums">{fmt(totals.d)}</span>
          <span className="ml-3 text-zinc-500">Σ credit: </span>
          <span className="font-medium tabular-nums">{fmt(totals.c)}</span>
          {totals.d > 0 && (
            <span
              className={`ml-3 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${
                totals.balanced
                  ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
                  : "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200"
              }`}
            >
              {totals.balanced ? "Balanced" : `Off by ${fmt(Math.abs(totals.d - totals.c))}`}
            </span>
          )}
        </div>
      </div>

      <button
        type="submit"
        disabled={!totals.balanced}
        className="mt-6 w-full rounded-md bg-zinc-900 py-2.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
      >
        Save journal entry
      </button>
    </div>
  );
}
