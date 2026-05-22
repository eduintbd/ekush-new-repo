// /portfolio — live derived view of every active holding. Replays the
// Trade ledger to get per-instrument qty + weighted-avg cost, joins the
// latest Price ≤ as-of-date for market value + unrealised P&L. Grouped
// by Instrument.category to mirror the workbook's Portfolio_Pinki_1
// layout.
//
// Admin-only action: "Revalue to market" → posts the FVTPL journal.
// Downloads: CSV + Excel (.xlsx). Excel uses the Pinki sheet styling.

import Link from "next/link";
import { requireStaff, canEdit } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { formatBdt } from "@/lib/format";
import {
  buildPortfolioAsOf,
  fromPrismaTrades,
  latestPricesMap,
  type PortfolioRow,
} from "@/lib/portfolio";
import { revalueToMarket } from "./actions";

type Search = { asOf?: string; fy?: string };

export const metadata = { title: "Portfolio — Staff portal" };

const CATEGORY_ORDER = [
  "listed_security",
  "mutual_fund_open",
  "private_placement",
  "ipo_application",
  "bond",
] as const;

const CATEGORY_LABEL: Record<string, string> = {
  listed_security: "Listed Securities",
  mutual_fund_open: "Open-End Mutual Funds",
  private_placement: "Private Placements",
  ipo_application: "IPO Applications",
  bond: "Bonds",
};

export default async function PortfolioPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const profile = await requireStaff();
  const editable = canEdit(profile);
  const sp = await searchParams;

  const fiscalYears = await prisma.fiscalYear
    .findMany({ orderBy: { startsOn: "desc" }, select: { id: true, label: true, isClosed: true } })
    .catch(() => []);
  const fy = fiscalYears.find((y) => y.id === sp.fy) ?? fiscalYears[0];

  // Default as-of date = latest available price date, falling back to today.
  const latestPriceDate = await prisma.price
    .findFirst({ orderBy: { priceDate: "desc" }, select: { priceDate: true } })
    .catch(() => null);
  const defaultAsOf = latestPriceDate?.priceDate.toISOString().slice(0, 10) ?? new Date().toISOString().slice(0, 10);
  const asOfRaw = sp.asOf && /^\d{4}-\d{2}-\d{2}$/.test(sp.asOf) ? sp.asOf : defaultAsOf;
  const asOf = new Date(`${asOfRaw}T00:00:00Z`);

  const [trades, prices, instruments] = await Promise.all([
    prisma.trade.findMany({
      where: { tradeDate: { lte: asOf } },
      orderBy: [{ tradeDate: "asc" }, { createdAt: "asc" }],
    }),
    prisma.price.findMany({ where: { priceDate: { lte: asOf } } }),
    prisma.instrument.findMany(),
  ]);

  const portfolio = buildPortfolioAsOf(fromPrismaTrades(trades), latestPricesMap(prices), asOf);
  const instrumentMap = new Map(instruments.map((i) => [i.code, i]));

  // Group by category in workbook order.
  type Row = PortfolioRow & { name: string; category: string };
  const rows: Row[] = portfolio.map((r) => {
    const inst = instrumentMap.get(r.instrumentCode);
    return { ...r, name: inst?.name ?? r.instrumentCode, category: inst?.category ?? "listed_security" };
  });
  const byCategory: Record<string, Row[]> = {};
  for (const r of rows) {
    (byCategory[r.category] ??= []).push(r);
  }
  const orderedCategories = CATEGORY_ORDER.filter((c) => byCategory[c]?.length);

  const totalCost = rows.reduce((s, r) => s + r.totalCost, 0);
  const totalMarket = rows.reduce((s, r) => s + (r.marketValue ?? 0), 0);
  const totalUnrealised = rows.reduce((s, r) => s + (r.unrealisedPnl ?? 0), 0);
  const anyMissing = rows.some((r) => r.unrealisedPnl === null);

  // Active FVA at this asOfDate (if any) — show as banner.
  const activeFva = fy
    ? await prisma.fairValueAdjustment.findFirst({
        where: { fiscalYearId: fy.id, asOfDate: asOf, reversedAt: null },
      })
    : null;

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10 dark:bg-zinc-950">
      <div className="mx-auto max-w-6xl print-area">
        <Link
          href="/dashboard"
          className="no-print text-xs uppercase tracking-widest text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
        >
          ← Dashboard
        </Link>
        <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-widest text-zinc-500">
              Ekush Wealth Management Limited
            </p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
              Portfolio
            </h1>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              As of {asOfRaw}
              {anyMissing && (
                <span className="ml-3 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium uppercase text-amber-800 dark:bg-amber-950 dark:text-amber-200">
                  Some instruments have no price ≤ this date
                </span>
              )}
            </p>
          </div>

          <form className="no-print flex flex-wrap items-end gap-2">
            <label className="block text-xs">
              <span className="font-medium text-zinc-500">Fiscal year</span>
              <select
                name="fy"
                defaultValue={fy?.id ?? ""}
                className="mt-1 block rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              >
                {fiscalYears.map((y) => (
                  <option key={y.id} value={y.id}>
                    {y.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-xs">
              <span className="font-medium text-zinc-500">As of</span>
              <input
                type="date"
                name="asOf"
                defaultValue={asOfRaw}
                className="mt-1 block rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              />
            </label>
            <button className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">
              View
            </button>
            <a
              href={`/api/exports/portfolio/csv?asOf=${asOfRaw}${fy ? `&fy=${fy.id}` : ""}`}
              className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800"
            >
              ⬇ CSV
            </a>
            <a
              href={`/api/exports/portfolio/xlsx?asOf=${asOfRaw}${fy ? `&fy=${fy.id}` : ""}`}
              className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800"
            >
              ⬇ Excel
            </a>
          </form>
        </div>

        {activeFva && (
          <div className="no-print mt-4 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-100">
            ✓ FVTPL journal posted for this date — unrealised{" "}
            <strong>
              {Number(activeFva.unrealisedPnl) >= 0 ? "+" : "−"}
              {formatBdt(Math.abs(Number(activeFva.unrealisedPnl)))}
            </strong>{" "}
            ·{" "}
            <Link
              href={`/journals/voucher/${activeFva.journalBatchId}`}
              className="font-mono underline-offset-2 hover:underline"
            >
              view voucher
            </Link>
            . Re-running for this date will reverse and re-post.
          </div>
        )}

        <div className="mt-6 overflow-x-auto rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
            <thead className="bg-zinc-50 dark:bg-zinc-950">
              <tr>
                <Th>Instrument</Th>
                <Th>Name</Th>
                <Th align="right">Quantity</Th>
                <Th align="right">Avg cost</Th>
                <Th align="right">Total cost</Th>
                <Th align="right">Market rate</Th>
                <Th align="right">Market value</Th>
                <Th align="right">Unrealised G/L</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center text-sm text-zinc-500">
                    No holdings on this date. Enter trades on{" "}
                    <Link href="/trades/new" className="underline">/trades/new</Link>.
                  </td>
                </tr>
              ) : (
                orderedCategories.flatMap((cat) => {
                  const items = byCategory[cat] ?? [];
                  const catCost = items.reduce((s, r) => s + r.totalCost, 0);
                  const catMarket = items.reduce((s, r) => s + (r.marketValue ?? 0), 0);
                  const catUnrealised = items.reduce((s, r) => s + (r.unrealisedPnl ?? 0), 0);
                  return [
                    <tr key={`${cat}-header`} className="bg-zinc-100 dark:bg-zinc-800">
                      <td colSpan={8} className="px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wider">
                        {CATEGORY_LABEL[cat]}
                      </td>
                    </tr>,
                    ...items.map((r) => (
                      <tr key={r.instrumentCode}>
                        <Td className="font-mono text-xs">{r.instrumentCode}</Td>
                        <Td className="text-zinc-700 dark:text-zinc-300">{r.name}</Td>
                        <Td align="right">{r.quantity.toLocaleString("en-IN")}</Td>
                        <Td align="right">{r.avgCost.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</Td>
                        <Td align="right">{formatBdt(r.totalCost)}</Td>
                        <Td align="right" className={r.marketRate === null ? "text-zinc-400" : ""}>
                          {r.marketRate === null ? "—" : r.marketRate.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}
                        </Td>
                        <Td align="right" className={r.marketValue === null ? "text-zinc-400" : ""}>
                          {r.marketValue === null ? "—" : formatBdt(r.marketValue)}
                        </Td>
                        <Td align="right">
                          {r.unrealisedPnl === null ? (
                            <span className="text-zinc-400">—</span>
                          ) : (
                            <span className={r.unrealisedPnl >= 0 ? "text-emerald-700 dark:text-emerald-300" : "text-red-700 dark:text-red-300"}>
                              {r.unrealisedPnl >= 0 ? "+" : "−"}{formatBdt(Math.abs(r.unrealisedPnl))}
                            </span>
                          )}
                        </Td>
                      </tr>
                    )),
                    <tr key={`${cat}-subtotal`} className="font-semibold">
                      <td colSpan={4} className="px-4 py-1.5 text-right text-xs uppercase tracking-wider text-zinc-500">
                        Subtotal {CATEGORY_LABEL[cat]}
                      </td>
                      <Td align="right">{formatBdt(catCost)}</Td>
                      <td />
                      <Td align="right">{formatBdt(catMarket)}</Td>
                      <Td align="right">
                        <span className={catUnrealised >= 0 ? "text-emerald-700 dark:text-emerald-300" : "text-red-700 dark:text-red-300"}>
                          {catUnrealised >= 0 ? "+" : "−"}{formatBdt(Math.abs(catUnrealised))}
                        </span>
                      </Td>
                    </tr>,
                  ];
                })
              )}
            </tbody>
            {rows.length > 0 && (
              <tfoot className="bg-zinc-100 dark:bg-zinc-800">
                <tr className="font-semibold">
                  <td colSpan={4} className="px-4 py-2 text-right text-xs uppercase tracking-wider">
                    Total
                  </td>
                  <Td align="right">{formatBdt(totalCost)}</Td>
                  <td />
                  <Td align="right">{formatBdt(totalMarket)}</Td>
                  <Td align="right">
                    <span className={totalUnrealised >= 0 ? "text-emerald-700 dark:text-emerald-300" : "text-red-700 dark:text-red-300"}>
                      {totalUnrealised >= 0 ? "+" : "−"}{formatBdt(Math.abs(totalUnrealised))}
                    </span>
                  </Td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>

        {editable && rows.length > 0 && !anyMissing && fy && !fy.isClosed && (
          <section className="no-print mt-6 rounded-lg border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">
              Fair-value adjustment
            </h2>
            <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
              Posts a single compound journal marking the portfolio to market as of{" "}
              <strong>{asOfRaw}</strong>. Re-running for the same date reverses the prior
              FVA and posts a fresh one (idempotent).
            </p>
            <form
              action={revalueToMarket}
              className="mt-3"
              data-confirm={`Post FVTPL journal for ${asOfRaw}? Unrealised ${totalUnrealised >= 0 ? "gain" : "loss"} ${formatBdt(Math.abs(totalUnrealised))} BDT will be recorded against Fair Value Reserve.`}
            >
              <input type="hidden" name="asOfDate" value={asOfRaw} />
              <input type="hidden" name="fiscalYearId" value={fy.id} />
              <button
                type="submit"
                className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900"
              >
                Revalue to market
              </button>
            </form>
          </section>
        )}
      </div>
    </main>
  );
}

function Th({ children, align = "left" }: { children: React.ReactNode; align?: "left" | "right" }) {
  const a = align === "right" ? "text-right" : "text-left";
  return (
    <th className={`${a} px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500`}>
      {children}
    </th>
  );
}

function Td({
  children,
  align = "left",
  className = "",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
  className?: string;
}) {
  const a = align === "right" ? "text-right tabular-nums" : "text-left";
  return <td className={`${a} px-4 py-2 ${className}`}>{children}</td>;
}
