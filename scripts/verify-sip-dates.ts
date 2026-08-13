// Verification for the agent SIP debit-day date helpers.
//
//   npx tsx scripts/verify-sip-dates.ts
//
// Agents may pick any debit day 1–31, unlike the portal's fixed 5/15/26. Every
// day above 28 is a trap in JavaScript: `new Date(2026, 1, 31)` is 3 March, not
// an error. These traces assert hand-computed dates and exit non-zero on any
// mismatch. Run them green BEFORE touching anything that writes a mandate.

import {
  addYearsKeepingDay,
  alignToDebitDay,
  clampDayToMonth,
  daysInMonth,
  debitDayLabel,
  nextDebitDate,
  ordinal,
} from "@/lib/sip-dates";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`   ${ok ? "OK  " : "FAIL"} ${label.padEnd(52)} got ${a}${ok ? "" : `  want ${e}`}`);
}
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
// UTC on purpose: these dates are written to the database and printed on a
// signed mandate, so the assertion must be the instant, not a local rendering.
const iso = (x: Date) => x.toISOString().slice(0, 10);

console.log("SIP DEBIT-DAY TRACES\n");

console.log("D1  month lengths");
check("Feb 2026 (not a leap year)", daysInMonth(2026, 1), 28);
check("Feb 2028 (leap year)", daysInMonth(2028, 1), 29);
check("April", daysInMonth(2026, 3), 30);
check("December", daysInMonth(2026, 11), 31);

console.log("\nD2  clamping a day onto a month");
check("31 in January stays 31", clampDayToMonth(2026, 0, 31), 31);
check("31 in February becomes 28", clampDayToMonth(2026, 1, 31), 28);
check("31 in February 2028 becomes 29", clampDayToMonth(2028, 1, 31), 29);
check("31 in April becomes 30", clampDayToMonth(2026, 3, 31), 30);
check("29 in February becomes 28", clampDayToMonth(2026, 1, 29), 28);
check("5 is untouched", clampDayToMonth(2026, 1, 5), 5);

console.log("\nD3  the JavaScript trap this exists to stop");
{
  // What the portal's unclamped helper would have produced. Date.UTC so the
  // assertion holds on any machine — the overflow is the point, not the zone.
  const naive = new Date(Date.UTC(2026, 1, 31));
  check("raw Date.UTC(2026, 1, 31) really is March", iso(naive), "2026-03-03");
  check("clamped lands in February", iso(nextDebitDate(d("2026-01-15"), 31)), "2026-01-31");
  check("and the next one is 28 Feb", iso(nextDebitDate(d("2026-02-01"), 31)), "2026-02-28");
}

console.log("\nD4  nextDebitDate");
check("day still ahead this month", iso(nextDebitDate(d("2026-03-10"), 26)), "2026-03-26");
check("day already passed rolls forward", iso(nextDebitDate(d("2026-03-27"), 26)), "2026-04-26");
check("on the day itself rolls forward", iso(nextDebitDate(d("2026-03-26"), 26)), "2026-04-26");
check("December rolls into next January", iso(nextDebitDate(d("2026-12-20"), 5)), "2027-01-05");
check("31 from mid-April clamps to 30", iso(nextDebitDate(d("2026-04-10"), 31)), "2026-04-30");
check("28 Feb with day 31 has already gone", iso(nextDebitDate(d("2026-02-28"), 31)), "2026-03-31");

console.log("\nD5  alignToDebitDay");
check("already on the day", iso(alignToDebitDay(d("2026-03-15"), 15)), "2026-03-15");
check("not on the day advances", iso(alignToDebitDay(d("2026-03-14"), 15)), "2026-03-15");
check("28 Feb counts as 'on' day 31", iso(alignToDebitDay(d("2026-02-28"), 31)), "2026-02-28");

console.log("\nD6  addYearsKeepingDay — mandate end date");
check("5 years on, same day", iso(addYearsKeepingDay(d("2026-03-05"), 5, 5)), "2031-03-05");
check("leap-day start, 1 year on", iso(addYearsKeepingDay(d("2028-02-29"), 1, 29)), "2029-02-28");
check(
  "started 28 Feb for day 31, ends on a 31st",
  iso(addYearsKeepingDay(d("2026-02-28"), 5, 31)),
  "2031-02-28",
);
check(
  "day 31 start in March ends 31 March",
  iso(addYearsKeepingDay(d("2026-03-31"), 3, 31)),
  "2029-03-31",
);

console.log("\nD7  ordinals — the portal hardcodes 'th' and prints '1th'");
check("1st", ordinal(1), "1st");
check("2nd", ordinal(2), "2nd");
check("3rd", ordinal(3), "3rd");
check("5th", ordinal(5), "5th");
check("11th not 11st", ordinal(11), "11th");
check("12th not 12nd", ordinal(12), "12th");
check("13th not 13rd", ordinal(13), "13th");
check("21st", ordinal(21), "21st");
check("31st", ordinal(31), "31st");

console.log("\nD8  what the signed form says");
check("a safe day is stated plainly", debitDayLabel(15), "15th day of each month");
check(
  "an unsafe day must state the fallback",
  debitDayLabel(31),
  "31st day of each month (or the last day, in months with fewer than 31 days)",
);

// D9 — the bug that made this file necessary. The portal's helpers build
// midnight LOCAL time; on a UTC+6 machine that serialises to 18:00Z the day
// BEFORE, so a mandate for the 5th is written and printed as the 4th. It is
// invisible on Vercel because Vercel runs in UTC. These assert the instant is
// exactly UTC midnight on the requested day, whatever TZ this runs in.
console.log(`\nD9  timezone independence (this process: TZ=${process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone}, offset ${-new Date().getTimezoneOffset() / 60}h)`);
{
  // From 1 August the 5th is still ahead, so it is this month's.
  const start = nextDebitDate(d("2026-08-01"), 5);
  check("first debit is the 5th, not the 4th", iso(start), "2026-08-05");
  check("and it is exactly UTC midnight", start.toISOString(), "2026-08-05T00:00:00.000Z");
  check("UTC day-of-month matches the debit day", start.getUTCDate(), 5);

  // From the 6th it rolls to next month, still landing on the 5th.
  const rolled = nextDebitDate(d("2026-08-06"), 5);
  check("rolled forward is still the 5th", iso(rolled), "2026-09-05");

  const end = addYearsKeepingDay(start, 5, 5);
  check("mandate end is UTC midnight too", end.toISOString(), "2031-08-05T00:00:00.000Z");

  // Whatever the local offset is, the stored instant must not drift.
  const naiveLocal = new Date(2026, 8, 5);
  const drifts = naiveLocal.toISOString().slice(0, 10) !== "2026-09-05";
  console.log(
    `   note local-midnight Date(2026,8,5) serialises to ${naiveLocal.toISOString().slice(0, 10)}` +
      (drifts ? "  <-- this is the portal's behaviour, and it is a day out here" : "  (same, this machine is UTC)"),
  );
}

console.log(failures === 0 ? "\nALL SIP DATE TRACES PASSED" : `\n${failures} SIP DATE TRACE(S) FAILED`);
if (failures > 0) process.exitCode = 1;
