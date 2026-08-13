// DDI mandate date helpers for agent-created SIPs.
//
// Ported from apps/portal/src/components/sip/sip-utils.ts, with ONE deliberate
// difference: the portal only ever offers debit days 5, 15 and 26, and its
// helpers carry the comment "All debit days are ≤ 26, so no month-length
// clamping is needed." Agents may pick ANY day 1–31, so that assumption no
// longer holds and every helper here clamps.
//
// Why clamping matters: `new Date(2026, 1, 31)` is not an error in JavaScript,
// it is 3 March. Left unclamped, a mandate for the 31st would silently move to
// the 2nd or 3rd of the following month in February, and to the 1st in every
// 30-day month — a debit on a date the investor never agreed to, printed onto
// a signed DDI form and uploaded to the bank.
//
// The rule: a day beyond the month's length lands on that month's LAST day.
// 31 Feb → 28 Feb (29 in a leap year), 31 Apr → 30 Apr. This is what BEFTN
// mandates do in practice, and it never moves a debit into a different month.
//
// EVERYTHING HERE IS UTC. The portal's helpers use `new Date(y, m, d)`, which
// is midnight LOCAL time; serialised to the database that becomes the previous
// day's 18:00Z for a UTC+6 server, and the debit date printed on the signed
// mandate comes out one day early. It survives on Vercel only because Vercel
// runs in UTC — the bug is invisible in production and appears the moment
// anything runs anywhere else. A date on a bank mandate should not depend on
// the timezone of the machine that computed it, so these build UTC midnight
// explicitly and read with getUTC*.

export const DEBIT_DAY_MIN = 1;
export const DEBIT_DAY_MAX = 31;

/** Days in `month` (0-indexed) of `year`, leap years included. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/** The debit day as it actually falls in one specific month. */
export function clampDayToMonth(year: number, month: number, debitDay: number): number {
  return Math.min(Math.max(1, Math.trunc(debitDay)), daysInMonth(year, month));
}

/** UTC midnight in `year`/`month` on `debitDay`, clamped to the month's last day. */
function dateOn(year: number, month: number, debitDay: number): Date {
  // Normalise the month first so callers can pass month 12 and mean next
  // January — Date.UTC handles the year roll, but we need the normalised month
  // to clamp against the right month length.
  const y = year + Math.floor(month / 12);
  const m = ((month % 12) + 12) % 12;
  return new Date(Date.UTC(y, m, clampDayToMonth(y, m, debitDay)));
}

/**
 * The next calendar date on `debitDay` strictly after `from`.
 *
 * Compares against the CLAMPED day, so a plan created on 28 February with a
 * debit day of 31 correctly reads "this month's debit already happened" rather
 * than waiting for a 31 February that never comes.
 */
export function nextDebitDate(from: Date, debitDay: number): Date {
  const y = from.getUTCFullYear();
  const m = from.getUTCMonth();
  const thisMonth = clampDayToMonth(y, m, debitDay);
  return from.getUTCDate() < thisMonth ? dateOn(y, m, debitDay) : dateOn(y, m + 1, debitDay);
}

/** Snap an arbitrary anchor onto the debit day, or advance to the next one. */
export function alignToDebitDay(date: Date, debitDay: number): Date {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  const clamped = clampDayToMonth(y, m, debitDay);
  return date.getUTCDate() === clamped ? dateOn(y, m, debitDay) : nextDebitDate(date, debitDay);
}

/**
 * Add whole years, keeping the requested debit day rather than the clamped one.
 *
 * Passing the ORIGINAL debitDay (not `date.getDate()`) matters: a mandate that
 * starts 28 Feb because the investor asked for the 31st should end on the 31st
 * of the closing month, not drift to the 28th for good.
 */
export function addYearsKeepingDay(date: Date, years: number, debitDay?: number): Date {
  const day = debitDay ?? date.getUTCDate();
  return dateOn(date.getUTCFullYear() + years, date.getUTCMonth(), day);
}

/** "5" → "5th", "1" → "1st", "22" → "22nd". */
export function ordinal(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const r10 = n % 10;
  const r100 = n % 100;
  if (r100 >= 11 && r100 <= 13) return `${n}th`;
  if (r10 === 1) return `${n}st`;
  if (r10 === 2) return `${n}nd`;
  if (r10 === 3) return `${n}rd`;
  return `${n}th`;
}

/**
 * How the debit day should be described on a form the investor signs. For days
 * that exist in every month this is just "the 5th". For 29–31 it has to say
 * what happens in February, or the form promises a date that does not exist.
 */
export function debitDayLabel(debitDay: number): string {
  const d = Math.trunc(debitDay);
  if (d <= 28) return `${ordinal(d)} day of each month`;
  return `${ordinal(d)} day of each month (or the last day, in months with fewer than ${d} days)`;
}

export const SIP_MIN_AMOUNT = 1000;
export const TENURE_MIN = 3;
export const TENURE_MAX = 30;
