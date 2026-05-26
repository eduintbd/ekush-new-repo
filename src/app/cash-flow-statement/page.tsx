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
  type CashFlowStatement,
  type CfsActivity,
} from "@/lib/cash-flow-statement";

type Search = { fy?: string; from?: string; to?: string };

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

  const cfs = await getCashFlowStatement(fy.id, fromDate, toDate);

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

      {cfs.cashAccounts.length === 0 ? (
        <p className="mt-10 text-sm text-zinc-500">
          No cash/bank accounts detected. Tag accounts with category &quot;Cash
          and bank balances&quot;.
        </p>
      ) : (
        <div className="mt-6 rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <Activity
            cfs={cfs}
            activity="OPERATING"
            title="A. Cash flows from OPERATING activities"
          />
          <Activity
            cfs={cfs}
            activity="INVESTING"
            title="B. Cash flows from INVESTING activities"
          />
          <Activity
            cfs={cfs}
            activity="FINANCING"
            title="C. Cash flows from FINANCING activities"
          />

          {/* Bottom roll-up */}
          <div className="border-t-2 border-zinc-300 px-5 py-4 dark:border-zinc-700">
            <Row
              label="Net increase / (decrease) in cash"
              value={cfs.totals.netChange}
              bold
            />
            <Row
              label={`Cash at beginning of period (${fromDate.toISOString().slice(0, 10)})`}
              value={cfs.openingCash}
            />
            <Row
              label={`Cash at end of period (${toDate.toISOString().slice(0, 10)})`}
              value={cfs.closingCash}
              bold
              hilite
            />
          </div>
        </div>
      )}
    </Shell>
  );
}

function Activity({
  cfs,
  activity,
  title,
}: {
  cfs: CashFlowStatement;
  activity: CfsActivity;
  title: string;
}) {
  const lines = cfs.lines.filter((l) => l.activity === activity);
  const t = cfs.totals;
  const net =
    activity === "OPERATING"
      ? t.netOperating
      : activity === "INVESTING"
        ? t.netInvesting
        : t.netFinancing;

  return (
    <section className="border-b border-zinc-200 px-5 py-4 last:border-b-0 dark:border-zinc-800">
      <h2 className="text-[11px] font-semibold uppercase tracking-widest text-zinc-500">
        {title}
      </h2>
      {lines.length === 0 ? (
        <p className="mt-2 text-xs italic text-zinc-400">
          No flows classified to this activity in the period.
        </p>
      ) : (
        <div className="mt-2 space-y-1">
          {lines.map((l) => {
            const showInflow = l.inflow > 0.005;
            const showOutflow = l.outflow > 0.005;
            // Show gross inflow + gross outflow on separate rows when both
            // exist (e.g. investments purchase + disposal); otherwise show
            // a single net row.
            return (
              <div key={l.subClass} className="group">
                {showInflow && (
                  <Row
                    label={l.subClass}
                    value={l.inflow}
                    indent
                    drilldown={l.byAccount
                      .filter((a) => a.inflow > 0.005)
                      .map((a) => ({ name: a.accountName, amount: a.inflow }))}
                  />
                )}
                {showOutflow && (
                  <Row
                    label={showInflow ? `  less: payments / outflows` : l.subClass}
                    value={-l.outflow}
                    indent
                    drilldown={l.byAccount
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
  indent = false,
  bold = false,
  hilite = false,
  drilldown,
}: {
  label: string;
  value: number;
  indent?: boolean;
  bold?: boolean;
  hilite?: boolean;
  drilldown?: Array<{ name: string; amount: number }>;
}) {
  const isNeg = value < -0.005;
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
          "flex items-center justify-between py-1 text-sm",
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
            "tabular-nums",
            isNeg ? "text-red-700 dark:text-red-300" : "",
          ].join(" ")}
        >
          {isNeg ? `(${formatBdt(Math.abs(value))})` : formatBdt(value)}
        </span>
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
