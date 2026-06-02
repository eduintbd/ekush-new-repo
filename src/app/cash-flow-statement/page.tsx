// /cash-flow-statement — IAS 7 direct-method Statement of Cash Flows.
//
// Reads cash/bank account movements from the journal and classifies the
// counter-account on the OPPOSITE side of each cash leg into Operating /
// Investing / Financing activities. Drill-down by account is collapsed by
// default; click the chevron to expand.
//
// Differs from /cash-flow (the counter-account listing) in three ways:
//   1. Apportionment uses only opposite-side counter-lines (so Source Tax
//      Dr in a mgmt-fee receipt doesn't dilute Receipts from customers).
//   2. Non-cash accrual accounts (Source Tax, Deferred Tax, etc.) are
//      excluded from apportionment.
//   3. Output groups counter-accounts into IAS 7 activities and sub-classes.

import Link from "next/link";
import { requireStaff } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { formatBdt } from "@/lib/format";
import { PrintButton } from "@/components/print-button";
import {
  getCashFlowStatement,
  getNonCashTransactions,
  type CashFlowStatement,
  type CfsActivity,
  type NonCashSection,
  type NonCashTransaction,
} from "@/lib/cash-flow-statement";

type Search = {
  fy?: string;
  from?: string;
  to?: string;
  /** Comparison FY id (full-year or same-period per `cmode`). */
  compare?: string;
  /** "year" (default — full compare FY) | "period" (same days-into-FY range). */
  cmode?: string;
};

export const metadata = { title: "Cash Flow Statement — Staff portal" };

export default async function CashFlowStatementPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  await requireStaff();
  const sp = await searchParams;

  const fiscalYears = await prisma.fiscalYear
    .findMany({
      orderBy: { startsOn: "desc" },
      select: { id: true, label: true, startsOn: true, endsOn: true },
    })
    .catch(() => []);
  if (fiscalYears.length === 0) {
    return (
      <Shell>
        <p className="mt-10 text-sm text-zinc-500">
          No fiscal years. Seed the DB first.
        </p>
      </Shell>
    );
  }

  const fy = fiscalYears.find((y) => y.id === sp.fy) ?? fiscalYears[0];
  const fromDate = sp.from ? new Date(sp.from) : fy.startsOn;
  const toDate = sp.to ? new Date(sp.to) : fy.endsOn;

  const compareId = sp.compare && sp.compare !== fy.id ? sp.compare : undefined;
  const compareMode: "year" | "period" = sp.cmode === "period" ? "period" : "year";
  const compareFy = compareId
    ? fiscalYears.find((y) => y.id === compareId)
    : undefined;

  // Derive compare date range:
  //   year-wise: compareFy.startsOn → compareFy.endsOn
  //   same-period: compareFy.startsOn + (fromDate - fy.startsOn) →
  //                compareFy.startsOn + (toDate   - fy.startsOn)
  let compareFromDate: Date | undefined;
  let compareToDate: Date | undefined;
  if (compareFy) {
    if (compareMode === "period") {
      const shiftDays = Math.floor(
        (fromDate.getTime() - fy.startsOn.getTime()) / 86_400_000,
      );
      const spanDays = Math.floor(
        (toDate.getTime() - fromDate.getTime()) / 86_400_000,
      );
      compareFromDate = new Date(compareFy.startsOn);
      compareFromDate.setUTCDate(compareFromDate.getUTCDate() + shiftDays);
      compareToDate = new Date(compareFromDate);
      compareToDate.setUTCDate(compareToDate.getUTCDate() + spanDays);
      // Clamp to compare FY range so we don't pull rows outside it.
      if (compareFromDate < compareFy.startsOn) compareFromDate = compareFy.startsOn;
      if (compareToDate > compareFy.endsOn) compareToDate = compareFy.endsOn;
    } else {
      compareFromDate = compareFy.startsOn;
      compareToDate = compareFy.endsOn;
    }
  }

  const [cfs, nonCash, compareCfs] = await Promise.all([
    getCashFlowStatement(fy.id, fromDate, toDate),
    getNonCashTransactions(fy.id, fromDate, toDate),
    compareFy && compareFromDate && compareToDate
      ? getCashFlowStatement(compareFy.id, compareFromDate, compareToDate)
      : Promise.resolve(null),
  ]);

  return (
    <Shell>
      <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-widest text-zinc-500">
            Staff portal
          </p>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            Cash Flow Statement
          </h1>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            IAS 7 direct method · {fromDate.toISOString().slice(0, 10)} →{" "}
            {toDate.toISOString().slice(0, 10)} · {cfs.cashAccounts.length}{" "}
            cash/bank account{cfs.cashAccounts.length === 1 ? "" : "s"}
          </p>
        </div>
        <form className="flex flex-wrap items-end gap-2 text-sm">
          <label className="block">
            <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
              Fiscal year
            </span>
            <select
              name="fy"
              defaultValue={fy.id}
              className="mt-1 block w-44 rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-900"
            >
              {fiscalYears.map((y) => (
                <option key={y.id} value={y.id}>
                  {y.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
              From
            </span>
            <input
              type="date"
              name="from"
              defaultValue={fromDate.toISOString().slice(0, 10)}
              className="mt-1 block rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
          <label className="block">
            <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
              To
            </span>
            <input
              type="date"
              name="to"
              defaultValue={toDate.toISOString().slice(0, 10)}
              className="mt-1 block rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
          <label className="block">
            <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
              Compare
            </span>
            <select
              name="compare"
              defaultValue={compareId ?? ""}
              className="mt-1 block w-44 rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-900"
            >
              <option value="">— none —</option>
              {fiscalYears
                .filter((y) => y.id !== fy.id)
                .map((y) => (
                  <option key={y.id} value={y.id}>
                    {y.label}
                  </option>
                ))}
            </select>
          </label>
          <label className="block">
            <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
              Mode
            </span>
            <select
              name="cmode"
              defaultValue={compareMode}
              title="Year-wise = full compare FY. Same period = same days-into-FY date range."
              className="mt-1 block rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-900"
            >
              <option value="year">Year-wise</option>
              <option value="period">Same period</option>
            </select>
          </label>
          <button
            type="submit"
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            Apply
          </button>
          <PrintButton />
        </form>
      </div>

      <p className="mt-3 text-xs text-zinc-500">
        Detail listing of every cash movement by counter-account:{" "}
        <Link
          href={`/cash-flow?fy=${fy.id}&from=${fromDate.toISOString().slice(0, 10)}&to=${toDate.toISOString().slice(0, 10)}`}
          className="underline hover:text-zinc-700 dark:hover:text-zinc-300"
        >
          /cash-flow
        </Link>
      </p>

      {compareCfs && (
        <p className="mt-2 text-xs text-zinc-500">
          Compared with <strong>{compareFy?.label}</strong>{" "}
          {compareMode === "period"
            ? `(same period: ${compareFromDate?.toISOString().slice(0, 10)} → ${compareToDate?.toISOString().slice(0, 10)})`
            : "(full year)"}
        </p>
      )}

      {cfs.cashAccounts.length === 0 ? (
        <p className="mt-10 text-sm text-zinc-500">
          No cash/bank accounts detected. Tag accounts with category &quot;Cash
          and bank balances&quot;.
        </p>
      ) : (
        <div className="mt-6 rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          {compareCfs && (
            <div className="grid grid-cols-[2fr_1fr_1fr] items-center gap-x-6 border-b border-zinc-200 bg-zinc-50 px-5 py-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950">
              <span />
              <span className="text-left">{fy.label}</span>
              <span className="text-left">{compareFy?.label}</span>
            </div>
          )}
          <Activity
            cfs={cfs}
            compare={compareCfs}
            activity="OPERATING"
            title="A. Cash flows from OPERATING activities"
          />
          <Activity
            cfs={cfs}
            compare={compareCfs}
            activity="INVESTING"
            title="B. Cash flows from INVESTING activities"
          />
          <Activity
            cfs={cfs}
            compare={compareCfs}
            activity="FINANCING"
            title="C. Cash flows from FINANCING activities"
          />

          {/* Bottom roll-up */}
          <div className="border-t-2 border-zinc-300 px-5 py-4 dark:border-zinc-700">
            <Row
              label="Net increase / (decrease) in cash"
              value={cfs.totals.netChange}
              compareValue={compareCfs?.totals.netChange ?? undefined}
              bold
            />
            <Row
              label={`Cash at beginning of period (${fromDate.toISOString().slice(0, 10)})`}
              value={cfs.openingCash}
              compareValue={compareCfs?.openingCash ?? undefined}
            />
            <Row
              label={`Cash at end of period (${toDate.toISOString().slice(0, 10)})`}
              value={cfs.closingCash}
              compareValue={compareCfs?.closingCash ?? undefined}
              bold
              hilite
            />
          </div>
        </div>
      )}

      <NonCashDisclosure section={nonCash} />
    </Shell>
  );
}

function NonCashDisclosure({ section }: { section: NonCashSection }) {
  const noMaterial =
    section.marginLoanFundedAcquisitions.length === 0 &&
    section.brokerSettledDisposals.length === 0;

  return (
    <div className="mt-8 rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
        <h2 className="text-[11px] font-semibold uppercase tracking-widest text-zinc-500">
          Note · Non-cash investing &amp; financing transactions (IAS 7.43)
        </h2>
        <p className="mt-1 text-xs text-zinc-500">
          Material transactions that did not require the use of cash or
          cash equivalents and are therefore excluded from the statement
          above. Disclosed for the user&apos;s understanding of investing
          and financing activity in the period.
        </p>
      </div>

      {noMaterial ? (
        <p className="px-5 py-4 text-sm italic text-zinc-500">
          No material non-cash investing or financing transactions in
          the period.
        </p>
      ) : (
        <div className="divide-y divide-zinc-200 dark:divide-zinc-800">
          {section.marginLoanFundedAcquisitions.length > 0 && (
            <NonCashGroup
              title="Acquisitions of investments funded by borrowings"
              note="Margin loan / broker liability increased to fund a share purchase; no bank account involved."
              txns={section.marginLoanFundedAcquisitions}
              total={section.totals.marginLoanFunded}
            />
          )}
          {section.brokerSettledDisposals.length > 0 && (
            <NonCashGroup
              title="Disposals settled through broker accounts (P&L recognised, no cash leg)"
              note="Share sales whose proceeds remained parked at the broker; realised gain or loss was recognised but no cash hit the bank in this voucher."
              txns={section.brokerSettledDisposals}
              total={section.totals.brokerSettledNet}
            />
          )}
        </div>
      )}

      {section.internalReallocations.length > 0 && (
        <details className="border-t border-zinc-200 px-5 py-3 text-xs dark:border-zinc-800">
          <summary className="cursor-pointer text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
            Plus {section.internalReallocations.length} reallocation
            voucher{section.internalReallocations.length === 1 ? "" : "s"}{" "}
            between investment / broker accounts —{" "}
            {formatBdt(section.totals.internalReallocation)} aggregate Dr
            volume (not material per IAS 7.43)
          </summary>
          <ul className="mt-2 space-y-0.5 text-zinc-500">
            {section.internalReallocations.slice(0, 20).map((t) => (
              <li key={t.voucherNo ?? Math.random()} className="font-mono">
                {t.date.toISOString().slice(0, 10)} · {t.voucherNo ?? "—"} ·{" "}
                {formatBdt(t.amount)} ·{" "}
                <span className="font-sans">{t.accounts.join(" / ")}</span>
              </li>
            ))}
            {section.internalReallocations.length > 20 && (
              <li className="italic">
                … {section.internalReallocations.length - 20} more
              </li>
            )}
          </ul>
        </details>
      )}
    </div>
  );
}

function NonCashGroup({
  title,
  note,
  txns,
  total,
}: {
  title: string;
  note: string;
  txns: NonCashTransaction[];
  total: number;
}) {
  return (
    <div className="px-5 py-4">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">
          {title}
        </h3>
        <span className="font-mono text-sm tabular-nums text-zinc-700 dark:text-zinc-300">
          {formatBdt(total)}
        </span>
      </div>
      <p className="mt-1 text-xs text-zinc-500">{note}</p>
      <ul className="mt-2 space-y-0.5 text-xs">
        {txns.map((t) => (
          <li
            key={t.voucherNo ?? Math.random()}
            className="flex flex-wrap items-baseline justify-between gap-2"
          >
            <span className="font-mono text-zinc-600 dark:text-zinc-400">
              {t.date.toISOString().slice(0, 10)} · {t.voucherNo ?? "—"}
            </span>
            <span className="text-zinc-500">{t.accounts.join(" + ")}</span>
            <span className="font-mono tabular-nums text-zinc-700 dark:text-zinc-300">
              {formatBdt(t.amount)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Activity({
  cfs,
  compare,
  activity,
  title,
}: {
  cfs: CashFlowStatement;
  compare: CashFlowStatement | null;
  activity: CfsActivity;
  title: string;
}) {
  const lines = cfs.lines.filter((l) => l.activity === activity);
  const compareLines = compare
    ? compare.lines.filter((l) => l.activity === activity)
    : [];
  const findCompare = (subClass: string) =>
    compareLines.find((l) => l.subClass === subClass);
  const t = cfs.totals;
  const net =
    activity === "OPERATING"
      ? t.netOperating
      : activity === "INVESTING"
        ? t.netInvesting
        : t.netFinancing;
  const compareNet = compare
    ? activity === "OPERATING"
      ? compare.totals.netOperating
      : activity === "INVESTING"
        ? compare.totals.netInvesting
        : compare.totals.netFinancing
    : undefined;

  // Merge sub-classes — show all that exist in either side.
  const allSubClasses = new Set<string>([
    ...lines.map((l) => l.subClass),
    ...compareLines.map((l) => l.subClass),
  ]);
  const mergedLines = Array.from(allSubClasses).map((sc) => {
    const cur = lines.find((l) => l.subClass === sc);
    const cmp = findCompare(sc);
    return {
      subClass: sc,
      order: cur?.order ?? cmp?.order ?? 99,
      cur,
      cmp,
    };
  });
  mergedLines.sort((a, b) => a.order - b.order);

  return (
    <section className="border-b border-zinc-200 px-5 py-4 last:border-b-0 dark:border-zinc-800">
      <h2 className="text-[11px] font-semibold uppercase tracking-widest text-zinc-500">
        {title}
      </h2>
      {mergedLines.length === 0 ? (
        <p className="mt-2 text-xs italic text-zinc-400">
          No flows classified to this activity in the period.
        </p>
      ) : (
        <div className="mt-2 space-y-1">
          {mergedLines.map(({ subClass, cur, cmp }) => {
            const curIn = cur?.inflow ?? 0;
            const curOut = cur?.outflow ?? 0;
            const cmpIn = cmp?.inflow ?? 0;
            const cmpOut = cmp?.outflow ?? 0;
            const showInflow = curIn > 0.005 || cmpIn > 0.005;
            const showOutflow = curOut > 0.005 || cmpOut > 0.005;
            return (
              <div key={subClass} className="group">
                {showInflow && (
                  <Row
                    label={subClass}
                    value={curIn}
                    compareValue={compare ? cmpIn : undefined}
                    indent
                    drilldown={(cur?.byAccount ?? [])
                      .filter((a) => a.inflow > 0.005)
                      .map((a) => ({ name: a.accountName, amount: a.inflow }))}
                  />
                )}
                {showOutflow && (
                  <Row
                    label={showInflow ? `  less: payments / outflows` : subClass}
                    value={-curOut}
                    compareValue={compare ? -cmpOut : undefined}
                    indent
                    drilldown={(cur?.byAccount ?? [])
                      .filter((a) => a.outflow > 0.005)
                      .map((a) => ({ name: a.accountName, amount: -a.outflow }))}
                  />
                )}
              </div>
            );
          })}
          <Row
            label={`Net cash ${net >= 0 ? "from" : "used in"} ${activity.toLowerCase()} activities`}
            value={net}
            compareValue={compareNet}
            bold
            hilite
          />
        </div>
      )}
    </section>
  );
}

function Row({
  label,
  value,
  compareValue,
  indent = false,
  bold = false,
  hilite = false,
  drilldown,
}: {
  label: string;
  value: number;
  compareValue?: number;
  indent?: boolean;
  bold?: boolean;
  hilite?: boolean;
  drilldown?: Array<{ name: string; amount: number }>;
}) {
  const isNeg = value < -0.005;
  const hasCompare = compareValue !== undefined;
  const cmpIsNeg = (compareValue ?? 0) < -0.005;
  const fmtCell = (v: number, neg: boolean) =>
    Math.abs(v) < 0.005
      ? "—"
      : neg
        ? `(${formatBdt(Math.abs(v))})`
        : formatBdt(v);
  return (
    <details
      className={[
        "flex flex-col",
        bold ? "font-semibold" : "",
        hilite ? "border-t border-zinc-200 pt-1 dark:border-zinc-800" : "",
      ].join(" ")}
    >
      <summary
        className={[
          hasCompare
            ? "grid grid-cols-[2fr_1fr_1fr] items-center gap-x-6 py-1 text-sm"
            : "grid grid-cols-[1fr_1fr] items-center gap-x-6 py-1 text-sm",
          indent ? "pl-4" : "",
          drilldown && drilldown.length > 0
            ? "cursor-pointer list-none [&::-webkit-details-marker]:hidden"
            : "cursor-default list-none [&::-webkit-details-marker]:hidden",
        ].join(" ")}
      >
        <span className="flex items-center gap-1.5">
          {drilldown && drilldown.length > 0 && (
            <span className="text-[9px] text-zinc-400 transition-transform group-open:rotate-90">
              ▸
            </span>
          )}
          <span>{label}</span>
        </span>
        <span
          className={[
            "tabular-nums text-left",
            isNeg ? "text-red-700 dark:text-red-300" : "",
          ].join(" ")}
        >
          {fmtCell(value, isNeg)}
        </span>
        {hasCompare && (
          <span
            className={[
              "tabular-nums text-left text-zinc-500",
              cmpIsNeg ? "text-red-700 dark:text-red-300" : "",
            ].join(" ")}
          >
            {fmtCell(compareValue ?? 0, cmpIsNeg)}
          </span>
        )}
      </summary>
      {drilldown && drilldown.length > 0 && (
        <div className="ml-8 mt-1 space-y-0.5 border-l border-zinc-200 pl-3 text-xs text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
          {drilldown.map((d) => {
            const isAmtNeg = d.amount < -0.005;
            return (
              <div
                key={d.name}
                className="flex items-center justify-between py-0.5"
              >
                <span>{d.name}</span>
                <span
                  className={[
                    "tabular-nums",
                    isAmtNeg ? "text-red-700 dark:text-red-300" : "",
                  ].join(" ")}
                >
                  {isAmtNeg
                    ? `(${formatBdt(Math.abs(d.amount))})`
                    : formatBdt(d.amount)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </details>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10 dark:bg-zinc-950">
      <div className="mx-auto max-w-4xl">
        <Link
          href="/dashboard"
          className="text-xs uppercase tracking-widest text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
        >
          ← Dashboard
        </Link>
        {children}
      </div>
    </main>
  );
}
