"use client";

// Pop-up confirmation shown after a new journal entry is saved. Rendered
// on /journals when the redirect from createJournal carries `?created=1`.
// Auto-dismisses after a few seconds; the user can also close it manually
// or click through to the printable voucher.

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export function SavedBanner({
  voucherNo,
  batchId,
}: {
  voucherNo: string;
  batchId: string;
}) {
  const router = useRouter();
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const t = setTimeout(() => {
      setVisible(false);
      // Strip the query string so a manual refresh doesn't re-show the toast.
      router.replace("/journals", { scroll: false });
    }, 6000);
    return () => clearTimeout(t);
  }, [router]);

  if (!visible) return null;

  const dismiss = () => {
    setVisible(false);
    router.replace("/journals", { scroll: false });
  };

  return (
    <div
      role="status"
      aria-live="polite"
      className="no-print fixed bottom-6 right-6 z-50 max-w-sm rounded-lg border border-emerald-300 bg-emerald-50 p-4 shadow-lg dark:border-emerald-900 dark:bg-emerald-950"
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-xs font-bold text-white"
        >
          ✓
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-emerald-900 dark:text-emerald-100">
            Journal entry saved
          </p>
          <p className="mt-0.5 text-xs text-emerald-800 dark:text-emerald-200">
            Voucher{" "}
            {batchId ? (
              <Link
                href={`/journals/voucher/${batchId}`}
                className="font-mono font-medium underline-offset-2 hover:underline"
              >
                {voucherNo}
              </Link>
            ) : (
              <span className="font-mono font-medium">{voucherNo}</span>
            )}{" "}
            is now in the books.
          </p>
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss"
          className="-m-1 rounded p-1 text-emerald-700 hover:bg-emerald-100 dark:text-emerald-300 dark:hover:bg-emerald-900"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
