"use client";

// Inline delete form for a journal voucher. Confirms before submitting so
// a stray click can't wipe a balanced compound entry.

import { deleteJournalBatch } from "@/app/journals/actions";

export function DeleteVoucherForm({ batchId, voucherNo }: { batchId: string; voucherNo: string | null }) {
  return (
    <form
      action={deleteJournalBatch}
      onSubmit={(e) => {
        const ok = window.confirm(
          `Delete voucher ${voucherNo ?? batchId.slice(0, 8)}? This removes every line of the entry and cannot be undone.`,
        );
        if (!ok) e.preventDefault();
      }}
    >
      <input type="hidden" name="batchId" value={batchId} />
      <button
        type="submit"
        className="rounded border border-red-300 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950"
      >
        Delete
      </button>
    </form>
  );
}
