// /agent/statements — the investor's statements, shown to the agent who
// sourced them in the SAME layout the investor sees at
// portal.ekushwml.com/statements: orange header table, per-fund rows, a
// totals row, and a Download PDF button per section.
//
// Previously this page rendered no data at all — just download buttons — so
// an agent had to download a PDF to see anything. It now fetches and displays
// each statement, matching the portal verbatim.
//
// Money basis matches the portal exactly: holdings are priced off the LIVE
// nav_records value (via getInvestmentUpdateRows), not the fund_holdings
// snapshot, whose totalMarketValue/totalUnrealizedGain freeze at the last
// INVESTORS.xlsx upload and go stale the moment a newer NAV lands. Unrealised
// gain is therefore derived as marketValue − costValue, as the portal does.

import Link from "next/link";
import { getAgentScope, agentOwnsCode } from "@/lib/agent-scope";
import { fetchInvestorsForAgent } from "@/lib/ekush-web/client";
import { getInvestorProfileByCode } from "@/lib/portal-investor";
import {
  getInvestmentUpdateRows,
  getTransactionRows,
  getDividendRows,
  getTaxCertsFull,
} from "@/lib/portal-statements";
import { getIncomeYear, latestIncomeYearCerts, certHasActivity } from "@/lib/tax-cert-income-year";
import { formatBdt } from "@/lib/format";

export const dynamic = "force-dynamic";

const TABS = [
  { key: "portfolio", label: "Portfolio" },
  { key: "transactions", label: "Transactions" },
  { key: "dividends", label: "Dividends" },
  { key: "tax", label: "Tax Certificates" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

const SECTION_TITLE: Record<TabKey, string> = {
  portfolio: "Portfolio Statements",
  transactions: "Transaction Statements",
  dividends: "Dividend Statements",
  tax: "Tax Certificates",
};

function ymd(d: Date | null | undefined): string {
  return d ? new Date(d).toISOString().slice(0, 10) : "—";
}

export default async function AgentStatementsPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string; tab?: string }>;
}) {
  const scope = await getAgentScope();
  const sp = await searchParams;
  const sourced = await fetchInvestorsForAgent(scope.agentCode).catch(() => []);

  const byCode = new Map<string, { name: string; funds: Set<string> }>();
  for (const s of sourced) {
    const e = byCode.get(s.investor_code) ?? { name: s.full_name, funds: new Set<string>() };
    e.funds.add(s.fund_code);
    byCode.set(s.investor_code, e);
  }
  const investors = Array.from(byCode.entries())
    .map(([code, v]) => ({ code, name: v.name, funds: Array.from(v.funds).sort() }))
    .sort((a, b) => a.code.localeCompare(b.code));

  // Only ever render an investor this agent actually sourced.
  const selectedCode =
    sp.code && byCode.has(sp.code) && agentOwnsCode(scope, sp.code) ? sp.code : undefined;
  const selected = selectedCode ? investors.find((i) => i.code === selectedCode) : undefined;
  const tab: TabKey = TABS.find((t) => t.key === sp.tab)?.key ?? "portfolio";

  const investor = selectedCode ? await getInvestorProfileByCode(selectedCode) : null;

  const holdings = investor && tab === "portfolio" ? await getInvestmentUpdateRows(investor.id) : [];
  const txns = investor && tab === "transactions" ? await getTransactionRows(investor.id) : [];
  const divs = investor && tab === "dividends" ? await getDividendRows(investor.id) : [];

  // Tax certificates: the portal shows the LATEST income year only, fund by
  // fund, dropping all-zero certs — see apps/portal/(portal)/tax-certificate.
  // Reproduced with the portal's own helpers so the two lists always agree.
  const allCerts = investor && tab === "tax" ? await getTaxCertsFull(investor.id) : [];
  const certs = latestIncomeYearCerts(
    allCerts.map((c) => ({ ...c, periodEnd: c.periodEnd ? new Date(c.periodEnd) : null })),
  ).filter((c) => certHasActivity(c as unknown as Record<string, unknown>));

  return (
    <main className="min-h-screen bg-emerald-50/30 px-6 py-10 dark:bg-emerald-950/30">
      <div className="mx-auto max-w-6xl space-y-6">
        <div className="text-xs uppercase tracking-widest text-zinc-500">
          <Link href="/agent" className="hover:text-zinc-700 dark:hover:text-zinc-300">← Dashboard</Link>
        </div>
        <div>
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">Statements</h1>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            The same statements your investor sees in their own account.
          </p>
        </div>

        <div className="grid gap-6 sm:grid-cols-[220px_1fr]">
          {/* Investor picker */}
          <aside className="h-fit rounded-lg border border-zinc-200 bg-white p-2 dark:border-zinc-800 dark:bg-zinc-900">
            <p className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              Investor ({investors.length})
            </p>
            {investors.length === 0 ? (
              <p className="px-2 py-2 text-xs text-zinc-500">No investors yet.</p>
            ) : (
              <ul className="max-h-[60vh] space-y-0.5 overflow-y-auto">
                {investors.map((inv) => (
                  <li key={inv.code}>
                    <Link
                      href={`/agent/statements?code=${encodeURIComponent(inv.code)}&tab=${tab}`}
                      className={`block rounded px-2 py-1.5 text-sm ${
                        inv.code === selectedCode
                          ? "bg-emerald-100 font-medium text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200"
                          : "text-zinc-700 hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-800"
                      }`}
                    >
                      <span className="font-mono text-xs">{inv.code}</span>
                      <span className="ml-2 text-zinc-500">{inv.name}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </aside>

          <section>
            {!selected ? (
              <div className="rounded-lg border border-zinc-200 bg-white p-4 text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900">
                Select an investor to see their statements.
              </div>
            ) : (
              <>
                <div className="mb-4 flex flex-wrap gap-1 border-b border-zinc-200 dark:border-zinc-800">
                  {TABS.map((t) => (
                    <Link
                      key={t.key}
                      href={`/agent/statements?code=${encodeURIComponent(selectedCode!)}&tab=${t.key}`}
                      className={`px-3 py-2 text-sm ${
                        t.key === tab
                          ? "border-b-2 border-[#F27023] font-medium text-[#F27023]"
                          : "text-zinc-600 hover:text-zinc-900 dark:text-zinc-400"
                      }`}
                    >
                      {t.label}
                    </Link>
                  ))}
                </div>

                <StatementCard
                  title={SECTION_TITLE[tab]}
                  subtitle={`${selectedCode} · ${selected.name}`}
                  // Tax certificates download per fund from their own row, the
                  // way the portal does — there is no "all funds" certificate.
                  pdfHref={
                    tab === "tax"
                      ? undefined
                      : `/api/agent/statements?code=${encodeURIComponent(selectedCode!)}&type=${tab}`
                  }
                >
                  {tab === "portfolio" && <PortfolioTable rows={holdings} />}
                  {tab === "transactions" && <TransactionsTable rows={txns} />}
                  {tab === "dividends" && <DividendsTable rows={divs} />}
                  {tab === "tax" && <TaxCertificateList rows={certs} />}
                </StatementCard>
              </>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}

/** Portal-style card: white, title left, orange Download PDF right. */
function StatementCard({
  title,
  subtitle,
  pdfHref,
  children,
}: {
  title: string;
  subtitle: string;
  /** Omitted when the section downloads per row instead. */
  pdfHref?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-[10px] border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
        <div>
          <p className="text-[16px] font-semibold text-zinc-900 dark:text-zinc-50">{title}</p>
          <p className="mt-0.5 text-xs text-zinc-500">{subtitle}</p>
        </div>
        {pdfHref && (
          <a
            href={pdfHref}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-[5px] bg-[#F27023] px-4 py-2 text-[13px] font-medium text-white hover:bg-[#d9631d]"
          >
            ↓ Download PDF
          </a>
        )}
      </div>
      <div className="overflow-x-auto">{children}</div>
    </div>
  );
}

function Th({ children, right = false }: { children: React.ReactNode; right?: boolean }) {
  return (
    <th
      className={`whitespace-nowrap px-5 py-3 text-[11px] font-semibold uppercase tracking-wider text-white ${
        right ? "text-right" : "text-left"
      }`}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  right = false,
  strong = false,
  tone,
}: {
  children: React.ReactNode;
  right?: boolean;
  strong?: boolean;
  tone?: "gain" | "loss";
}) {
  const colour =
    tone === "gain"
      ? "text-emerald-600 dark:text-emerald-400"
      : tone === "loss"
        ? "text-red-600 dark:text-red-400"
        : "text-zinc-700 dark:text-zinc-300";
  return (
    <td
      className={`whitespace-nowrap px-5 py-3 text-sm tabular-nums ${right ? "text-right" : ""} ${
        strong ? "font-semibold" : ""
      } ${colour}`}
    >
      {children}
    </td>
  );
}

/** Signed money cell — green for a gain, red for a loss, as the portal shows. */
function Money({ n }: { n: number }) {
  return <>{formatBdt(n)}</>;
}

function EmptyRow({ cols, what }: { cols: number; what: string }) {
  return (
    <tr>
      <td colSpan={cols} className="px-5 py-8 text-center text-sm text-zinc-500">
        No {what} to show.
      </td>
    </tr>
  );
}

function PortfolioTable({
  rows,
}: {
  rows: Array<{
    fundCode: string;
    costValue: number | string;
    marketValue: number | string;
    realizedGain: number | string;
  }>;
}) {
  const r = rows.map((x) => ({
    fundCode: x.fundCode,
    cost: Number(x.costValue),
    market: Number(x.marketValue),
    realized: Number(x.realizedGain),
    unrealized: Number(x.marketValue) - Number(x.costValue),
  }));
  const t = r.reduce(
    (a, x) => ({
      cost: a.cost + x.cost,
      market: a.market + x.market,
      realized: a.realized + x.realized,
      unrealized: a.unrealized + x.unrealized,
    }),
    { cost: 0, market: 0, realized: 0, unrealized: 0 },
  );

  return (
    <table className="min-w-full">
      <thead className="bg-[#F27023]">
        <tr>
          <Th>Fund</Th>
          <Th right>Cost Value</Th>
          <Th right>Market Value</Th>
          <Th right>Realized Gain</Th>
          <Th right>Unrealized Gain</Th>
        </tr>
      </thead>
      <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
        {r.length === 0 ? (
          <EmptyRow cols={5} what="holdings" />
        ) : (
          r.map((x) => (
            <tr key={x.fundCode}>
              <Td strong>{x.fundCode}</Td>
              <Td right><Money n={x.cost} /></Td>
              <Td right><Money n={x.market} /></Td>
              <Td right tone={x.realized >= 0 ? "gain" : "loss"}><Money n={x.realized} /></Td>
              <Td right tone={x.unrealized >= 0 ? "gain" : "loss"}><Money n={x.unrealized} /></Td>
            </tr>
          ))
        )}
        {r.length > 0 && (
          <tr className="bg-zinc-50 dark:bg-zinc-950">
            <Td strong>Total</Td>
            <Td right strong><Money n={t.cost} /></Td>
            <Td right strong><Money n={t.market} /></Td>
            <Td right strong tone={t.realized >= 0 ? "gain" : "loss"}><Money n={t.realized} /></Td>
            <Td right strong tone={t.unrealized >= 0 ? "gain" : "loss"}><Money n={t.unrealized} /></Td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

function TransactionsTable({
  rows,
}: {
  rows: Array<{
    fundCode: string;
    orderDate: Date;
    direction: string;
    channel: string;
    units: number | string;
    nav: number | string;
    amount: number | string;
  }>;
}) {
  return (
    <table className="min-w-full">
      <thead className="bg-[#F27023]">
        <tr>
          <Th>Date</Th>
          <Th>Fund</Th>
          <Th>Type</Th>
          <Th>Channel</Th>
          <Th right>Units</Th>
          <Th right>NAV</Th>
          <Th right>Amount</Th>
        </tr>
      </thead>
      <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
        {rows.length === 0 ? (
          <EmptyRow cols={7} what="transactions" />
        ) : (
          rows.map((x, i) => (
            <tr key={i}>
              <Td>{ymd(x.orderDate)}</Td>
              <Td strong>{x.fundCode}</Td>
              <Td tone={x.direction === "BUY" ? "gain" : "loss"}>{x.direction}</Td>
              <Td>{x.channel}</Td>
              <Td right>{Number(x.units).toLocaleString("en-IN", { maximumFractionDigits: 2 })}</Td>
              <Td right>{Number(x.nav).toFixed(3)}</Td>
              <Td right strong><Money n={Number(x.amount)} /></Td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}

function DividendsTable({
  rows,
}: {
  rows: Array<{
    fundCode: string;
    accountingYear: string | null;
    paymentDate: Date | null;
    totalUnits: number | string;
    dividendPerUnit: number | string;
    grossDividend: number | string;
    taxAmount: number | string;
    netDividend: number | string;
  }>;
}) {
  const total = rows.reduce(
    (a, x) => ({
      gross: a.gross + Number(x.grossDividend),
      tax: a.tax + Number(x.taxAmount),
      net: a.net + Number(x.netDividend),
    }),
    { gross: 0, tax: 0, net: 0 },
  );
  return (
    <table className="min-w-full">
      <thead className="bg-[#F27023]">
        <tr>
          <Th>Year</Th>
          <Th>Fund</Th>
          <Th>Paid on</Th>
          <Th right>Units</Th>
          <Th right>Per Unit</Th>
          <Th right>Gross</Th>
          <Th right>Tax</Th>
          <Th right>Net</Th>
        </tr>
      </thead>
      <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
        {rows.length === 0 ? (
          <EmptyRow cols={8} what="dividends" />
        ) : (
          rows.map((x, i) => (
            <tr key={i}>
              <Td>{x.accountingYear ?? "—"}</Td>
              <Td strong>{x.fundCode}</Td>
              <Td>{ymd(x.paymentDate)}</Td>
              <Td right>{Number(x.totalUnits).toLocaleString("en-IN", { maximumFractionDigits: 2 })}</Td>
              <Td right>{Number(x.dividendPerUnit).toFixed(4)}</Td>
              <Td right><Money n={Number(x.grossDividend)} /></Td>
              <Td right><Money n={Number(x.taxAmount)} /></Td>
              <Td right strong tone="gain"><Money n={Number(x.netDividend)} /></Td>
            </tr>
          ))
        )}
        {rows.length > 0 && (
          <tr className="bg-zinc-50 dark:bg-zinc-950">
            <Td strong>Total</Td>
            <Td>{""}</Td>
            <Td>{""}</Td>
            <Td>{""}</Td>
            <Td>{""}</Td>
            <Td right strong><Money n={total.gross} /></Td>
            <Td right strong><Money n={total.tax} /></Td>
            <Td right strong tone="gain"><Money n={total.net} /></Td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

/**
 * Mirrors portal.ekushwml.com/tax-certificate: one row per fund for the latest
 * income year, each with its own Download button. The wide period/units/cost
 * table this replaced was a financial summary, not a tax certificate — the
 * real document is one fund, one income year, on AMC letterhead.
 */
function TaxCertificateList({
  rows,
}: {
  rows: Array<{ id: string; fundName: string; fundCode: string; periodEnd: Date | null }>;
}) {
  return (
    <table className="min-w-full">
      <thead className="bg-[#F27023]">
        <tr>
          <Th>Fund</Th>
          <Th>Income Year</Th>
          <Th right>{""}</Th>
        </tr>
      </thead>
      <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
        {rows.length === 0 ? (
          <EmptyRow cols={3} what="tax certificates" />
        ) : (
          rows.map((c) => (
            <tr key={c.id}>
              <Td strong>{c.fundName}</Td>
              <Td>{getIncomeYear(c.periodEnd ? new Date(c.periodEnd) : null)}</Td>
              <td className="whitespace-nowrap px-5 py-3 text-right">
                <a
                  href={`/agent/tax-certificate?id=${encodeURIComponent(c.id)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-block rounded-[5px] bg-[#F27023] px-4 py-2 text-[13px] font-medium text-white hover:bg-[#d9631d]"
                >
                  ↓ Download Tax Certificate
                </a>
              </td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}
