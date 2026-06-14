"use client";

// Small client wrapper around window.print() — every report page uses
// this so the user can save the current view as PDF via the browser's
// standard print dialog (Chrome / Firefox / Safari all support
// "Destination: Save as PDF").

import type { ReactNode } from "react";

export function PrintButton({
  children = "🖨 Print / Save as PDF",
  className,
}: {
  children?: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className={
        className ??
        "no-print rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
      }
    >
      {children}
    </button>
  );
}

/**
 * Print a single section of the page. Adds `body.<bodyClass>` (default
 * "diag-print") so a print stylesheet can hide everything else, fires the
 * browser print dialog, then removes the class. Used by the Balance Sheet
 * "Why it doesn't balance" panel to save just that section as a PDF.
 */
export function PrintSectionButton({
  children = "🖨 Print this section",
  bodyClass = "diag-print",
  className,
}: {
  children?: ReactNode;
  bodyClass?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => {
        const cleanup = () => {
          document.body.classList.remove(bodyClass);
          window.removeEventListener("afterprint", cleanup);
        };
        document.body.classList.add(bodyClass);
        window.addEventListener("afterprint", cleanup);
        window.print();
        // Fallback for browsers that don't fire afterprint reliably.
        setTimeout(cleanup, 1500);
      }}
      className={
        className ??
        "no-print rounded-md border border-amber-400 px-2.5 py-1 text-[11px] font-medium text-amber-900 hover:bg-amber-100 dark:border-amber-700 dark:text-amber-100 dark:hover:bg-amber-900/40"
      }
    >
      {children}
    </button>
  );
}
