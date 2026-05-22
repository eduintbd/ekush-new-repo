"use client";

// Inline delete form for one Trade row. The global <FormGuard> intercepts
// submit, fires the window.confirm via data-confirm, and disables the
// button during the post — so this component just owns the form action +
// the markup.

import { deleteTrade } from "./actions";

export function DeleteTradeForm({ tradeId, label }: { tradeId: string; label: string }) {
  return (
    <form
      action={deleteTrade}
      className="inline"
      data-confirm={`Delete this ${label} trade? The matching journal voucher will also be removed.`}
    >
      <input type="hidden" name="id" value={tradeId} />
      <button
        type="submit"
        className="rounded border border-red-300 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950"
      >
        Delete
      </button>
    </form>
  );
}
