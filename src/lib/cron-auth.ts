// Shared helpers for the /api/cron/* routes:
//   - authoriseCron: accepts either Vercel Cron's `Authorization: Bearer
//     $CRON_SECRET` or the older custom `x-cron-secret` header so manual
//     and external schedulers continue to work.
//   - calendarQuarter / lastCompletedQuarter / todayUtc: UTC-anchored
//     quarter math used by daily-accrual and quarterly-trail.

import type { NextRequest } from "next/server";

export function authoriseCron(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;

  const bearer = req.headers.get("authorization");
  if (bearer && bearer === `Bearer ${expected}`) return true;

  const custom = req.headers.get("x-cron-secret");
  if (custom && custom === expected) return true;

  return false;
}

/** Midnight UTC of today as a Date. */
export function todayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Calendar quarter window [start, end) containing `d`. */
export function calendarQuarter(d: Date): { start: Date; end: Date; label: string } {
  const y = d.getUTCFullYear();
  const q = Math.floor(d.getUTCMonth() / 3); // 0..3
  const start = new Date(Date.UTC(y, q * 3, 1));
  const end = new Date(Date.UTC(y, q * 3 + 3, 1));
  return { start, end, label: `Q${q + 1} ${y}` };
}

/** Calendar month window [start, end) containing `d`. */
export function calendarMonth(d: Date): { start: Date; end: Date; label: string } {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const start = new Date(Date.UTC(y, m, 1));
  const end = new Date(Date.UTC(y, m + 1, 1));
  return { start, end, label: start.toISOString().slice(0, 7) };
}

/** The just-completed calendar month relative to `d`. For the monthly-trail
 * run, which fires on the 1st of the new month and processes the month
 * that just ended. `end` is exclusive (1st of current month); `endInclusive`
 * is the last day of the completed month. */
export function lastCompletedMonth(d: Date): {
  start: Date;
  end: Date;
  endInclusive: Date;
  label: string;
} {
  const current = calendarMonth(d);
  const end = current.start; // start of current = end of prior (exclusive)
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 1, 1));
  const endInclusive = new Date(end);
  endInclusive.setUTCDate(endInclusive.getUTCDate() - 1);
  return { start, end, endInclusive, label: start.toISOString().slice(0, 7) };
}

/** The just-completed calendar quarter relative to `d`. Useful for the
 * quarterly-trail run, which fires on the 1st of the new quarter and
 * processes the quarter that just ended. */
export function lastCompletedQuarter(d: Date): {
  start: Date;
  end: Date;
  /** Inclusive last day, suitable for human-readable label / period_end. */
  endInclusive: Date;
  label: string;
} {
  const current = calendarQuarter(d);
  const end = current.start; // start of current = end of prior (exclusive)
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 3, 1));
  const endInclusive = new Date(end);
  endInclusive.setUTCDate(endInclusive.getUTCDate() - 1);
  const q = Math.floor(start.getUTCMonth() / 3) + 1;
  return { start, end, endInclusive, label: `Q${q} ${start.getUTCFullYear()}` };
}
