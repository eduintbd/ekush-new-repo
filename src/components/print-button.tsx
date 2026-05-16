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
