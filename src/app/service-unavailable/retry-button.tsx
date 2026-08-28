"use client";

import { useEffect, useState } from "react";

// "Try again" with a visible countdown. The countdown is the point: without
// one people re-submit every second during an outage, which is how a single
// investor produced 11 login attempts in 40 minutes on 2026-08-28.
const RETRY_SECONDS = 30;

export function RetryButton() {
  const [left, setLeft] = useState(RETRY_SECONDS);

  useEffect(() => {
    if (left <= 0) return;
    const t = setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [left]);

  return (
    <button
      type="button"
      disabled={left > 0}
      onClick={() => window.location.reload()}
      className="w-full rounded-md bg-zinc-900 py-2.5 text-sm font-medium text-white transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
    >
      {left > 0 ? `Try again in ${left}s` : "Try again"}
    </button>
  );
}
