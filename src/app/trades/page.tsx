// /trades — chronological list of every buy/sell entered into the
// system. Each row links to its auto-generated journal voucher (BV / SV
// prefix) for printing or audit. Date + instrument filters. Delete
// allowed only on the most-recent trade per instrument (because cost
// basis of later trades depends on this one).

import Link from "next/link";
import type { Prisma } from "@/generated/prisma";
import { requireStaff, canEdit } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { formatBdt } from "@/lib/format";
import { DeleteTradeForm } from "./delete-trade-form";

type Search = {
  fy?: string;
  from?: string;
  to?: string;
  instrument?: string;
  side?: "BUY" | "SELL" | "";
};

export const metadata = { title: "Trades — Staff portal" };

export default async function TradesPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const profile = await requireStaff();
  const editable = canEdit(profile);
  const sp = await searchParams;

  const fiscalYears = await prisma.fiscalYear
    .findMany({ orderBy: { startsOn: "desc" }, select: { id: true, label: true } })
    .catch(() => []);
  const instruments = await prisma.instrument
    .findMany({ where: { isActive: true }, orderBy: { code: "asc" }, select: { code: true, name: true } })
    .catch(() => []);

  const fyId = sp.fy ?? fiscalYears[0]?.id;

  const where: Prisma.TradeWhereInput = fyId
    ? {
        fiscalYearId: fyId,
        ...(sp.instrument ? { instrumentCode: sp.instrument } : {}),
        ...(sp.side ? { side: sp.side } : {}),
        ...(sp.from || sp.to
          ? {
              tradeDate: {
                ...(sp.from ? { gte: new Date(sp.from) } : {}),
                ...(sp.to ? { lte: new Date(sp.to) } : {}),
              },
            }
          : {}),
      }
    : {};

  const trades = fyId
    ? await prisma.trade
        .findMany({
          where,
          orderBy: [{ tradeDate: "desc" }, { createdAt: "desc" }],
          take: 500,
        })
        .catch(() => [])
    : [];

  // For delete enable/disable: find the most-recent trade per instrument
  // within this filtered view. Only that row is deletable.
  const latestByInstrument = new Map<string, string>();
  for (const t of trades) {
    if (!latestByInstrument.has(t.instrumentCode)) latestByInstrument.set(t.instrumentCode, t.id);
  }

  const buyTotal = trades.filter((t) => t.side === "BUY").reduce((s, t) => s + Number(t.grossAmount), 0);
  const sellTotal = trades.filter((t) => t.side === "SELL").reduce((s, t) => s + Number(t.grossAmount), 0);
  const realisedPnl = trades.reduce((s, t) => s + Number(t.realisedPnl ?? 0), 0);

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10 dark:bg-zinc-950">
      <div className="mx-auto max-w-7xl">
        <Link
          href="/dashboard"
          className="text-xs uppercase tracking-widest text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
        >
          ← Dashboard
        </Link>
        <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-widest text-zinc-500">Staff portal</p>
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
              Trades
            </h1>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              {trades.length} trade{trades.length === 1 ? "" : "s"}
              {" · "}Σ buys {formatBdt(buyTotal)}
              {" · "}Σ sells {formatBdt(sellTotal)}
              {" · "}Σ realised P&L{" "}
              <span className={realisedPnl >= 0 ? "text-emerald-700 dark:text-emerald-300" : "text-red-700 dark:text-red-300"}>
                {realisedPnl >= 0 ? "+" : "−"}{formatBdt(Math.abs(realisedPnl))}
              </span>
            </p>
          </div>
          {editable && (
            <Link
              href="/trades/new"
              className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900"
            >
              + New trade
            </Link>
          )}
        </div>

        <form className="mt-6 grid grid-cols-2 gap-2 text-sm sm:grid-cols-5">
          <label className="block">
            <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">Fiscal year</span>
            <select
              name="fy"
              defaultValue={fyId ?? ""}
              className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-900"
            >
              {fiscalYears.map((y) => (
                <option key={y.id} value={y.id}>
                  {y.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">From</span>
            <input
              type="date"
              name="from"
              defaultValue={sp.from}
              className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
          <label className="block">
            <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">To</span>
            <input
              type="date"
              name="to"
              defaultValue={sp.to}
              className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
          <label className="block">
            <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">Instrument</span>
            <select
              name="instrument"
              defaultValue={sp.instrument ?? ""}
              className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-900"
            >
              <option value="">any</option>
              {instruments.map((i) => (
                <option key={i.code} value={i.code}>
                  {i.code}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">Side</span>
            <select
              name="side"
              defaultValue={sp.side ?? ""}
              className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-900"
            >
              <option value="">any</option>
              <option value="BUY">BUY</option>
              <option value="SELL">SELL</option>
            </select>
          </label>
          <div className="col-span-2 sm:col-span-5 flex items-center gap-2">
            <button className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">
              Apply
            </button>
            {(sp.from || sp.to || sp.instrument || sp.side) && (
              <Link
                href={`/trades${fyId ? `?fy=${fyId}` : ""}`}
                className="text-xs text-zinc-500 underline hover:text-zinc-700 dark:hover:text-zinc-300"
              >
                Clear
              </Link>
            )}
          </div>
        </form>

        {trades.length === 0 ? (
          <p className="mt-10 text-sm text-zinc-500">No trades for this filter.</p>
        ) : (
          <div className="mt-6 overflow-x-auto rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
              <thead className="bg-zinc-50 dark:bg-zinc-950">
                <tr>
                  <Th>Date</Th>
                  <Th>Voucher</Th>
                  <Th>Side</Th>
                  <Th>Broker</Th>
                  <Th>Instrument</Th>
                  <Th align="right">Qty</Th>
                  <Th align="right">Rate</Th>
                  <Th align="right">Gross</Th>
                  <Th align="right">Cost basis</Th>
                  <Th align="right">Realised P&L</Th>
                  <Th>Settlement A/C</Th>
                  {editable && <Th>&nbsp;</Th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {trades.map((t) => (
                  <tr key={t.id}>
                    <Td className="whitespace-nowrap">{t.tradeDate.toISOString().slice(0, 10)}</Td>
                    <Td className="font-mono text-xs text-zinc-600 dark:text-zinc-400">
                      {t.journalBatchId ? (
                        <Link
                          href={`/journals/voucher/${t.journalBatchId}`}
                          className="underline-offset-2 hover:underline"
                        >
                          {t.side === "BUY" ? "BV/…" : "SV/…"}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </Td>
                    <Td>
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${
                          t.side === "BUY"
                            ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
                            : "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200"
                        }`}
                      >
                        {t.side}
                      </span>
                    </Td>
                    <Td className="text-xs text-zinc-500">
                      {t.brokerCode === "UCB" ? "UCB" : t.brokerCode === "PRIMEBANK" ? "Prime Bank" : "—"}
                    </Td>
                    <Td className="font-mono text-xs">{t.instrumentCode}</Td>
                    <Td align="right">{Number(t.quantity).toLocaleString("en-IN")}</Td>
                    <Td align="right">{Number(t.rate).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</Td>
                    <Td align="right" className="font-medium">{formatBdt(Number(t.grossAmount))}</Td>
                    <Td align="right" className="text-zinc-500">
                      {t.costBasis ? formatBdt(Number(t.costBasis)) : "—"}
                    </Td>
                    <Td align="right">
                      {t.realisedPnl ? (
                        <span className={Number(t.realisedPnl) >= 0 ? "text-emerald-700 dark:text-emerald-300" : "text-red-700 dark:text-red-300"}>
                          {Number(t.realisedPnl) >= 0 ? "+" : "−"}{formatBdt(Math.abs(Number(t.realisedPnl)))}
                        </span>
                      ) : (
                        "—"
                      )}
                    </Td>
                    <Td className="text-xs text-zinc-500">{t.bankAccount}</Td>
                    {editable && (
                      <Td>
                        {latestByInstrument.get(t.instrumentCode) === t.id && (
                          <DeleteTradeForm tradeId={t.id} label={`${t.side} ${t.instrumentCode}`} />
                        )}
                      </Td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
