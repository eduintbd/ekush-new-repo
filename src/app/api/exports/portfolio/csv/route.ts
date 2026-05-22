// CSV export of the portfolio as of a given date. Mirrors /portfolio's
// rows, grouped by category (subtotal rows interleaved).

import { type NextRequest } from "next/server";
import { requireStaff } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { buildPortfolioAsOf, fromPrismaTrades, latestPricesMap } from "@/lib/portfolio";
import { csvResponse, toCsv } from "@/lib/csv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CATEGORY_ORDER = ["listed_security", "mutual_fund_open", "private_placement", "ipo_application", "bond"];
const CATEGORY_LABEL: Record<string, string> = {
  listed_security: "Listed Securities",
  mutual_fund_open: "Open-End Mutual Funds",
  private_placement: "Private Placements",
  ipo_application: "IPO Applications",
  bond: "Bonds",
};

export async function GET(req: NextRequest) {
  await requireStaff();
  const asOfRaw = req.nextUrl.searchParams.get("asOf");
  if (!asOfRaw || !/^\d{4}-\d{2}-\d{2}$/.test(asOfRaw)) {
    return new Response("asOf=YYYY-MM-DD required", { status: 400 });
  }
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
  const instMap = new Map(instruments.map((i) => [i.code, i]));

  type Row = {
    Category: string;
    Instrument: string;
    Name: string;
    Quantity: number | "";
    "Avg cost": number | "";
    "Total cost": number | "";
    "Market rate": number | string;
    "Market value": number | string;
    "Unrealised G/L": number | string;
  };
  const rows: Row[] = [];
  const byCategory: Record<string, typeof portfolio> = {};
  for (const p of portfolio) {
    const cat = instMap.get(p.instrumentCode)?.category ?? "listed_security";
    (byCategory[cat] ??= []).push(p);
  }
  for (const cat of CATEGORY_ORDER) {
    const items = byCategory[cat] ?? [];
    if (items.length === 0) continue;
    for (const p of items) {
      const inst = instMap.get(p.instrumentCode);
      rows.push({
        Category: CATEGORY_LABEL[cat] ?? cat,
        Instrument: p.instrumentCode,
        Name: inst?.name ?? p.instrumentCode,
        Quantity: p.quantity,
        "Avg cost": p.avgCost,
        "Total cost": p.totalCost,
        "Market rate": p.marketRate ?? "",
        "Market value": p.marketValue ?? "",
        "Unrealised G/L": p.unrealisedPnl ?? "",
      });
    }
    const subTotalCost = items.reduce((s, r) => s + r.totalCost, 0);
    const subMarket = items.reduce((s, r) => s + (r.marketValue ?? 0), 0);
    const subUnreal = items.reduce((s, r) => s + (r.unrealisedPnl ?? 0), 0);
    rows.push({
      Category: `${CATEGORY_LABEL[cat]} subtotal`,
      Instrument: "",
      Name: "",
      Quantity: "",
      "Avg cost": "",
      "Total cost": subTotalCost,
      "Market rate": "",
      "Market value": subMarket,
      "Unrealised G/L": subUnreal,
    });
  }
  const totalCost = portfolio.reduce((s, r) => s + r.totalCost, 0);
  const totalMarket = portfolio.reduce((s, r) => s + (r.marketValue ?? 0), 0);
  const totalUnrealised = portfolio.reduce((s, r) => s + (r.unrealisedPnl ?? 0), 0);
  rows.push({
    Category: "TOTAL",
    Instrument: "",
    Name: "",
    Quantity: "",
    "Avg cost": "",
    "Total cost": totalCost,
    "Market rate": "",
    "Market value": totalMarket,
    "Unrealised G/L": totalUnrealised,
  });

  return csvResponse(toCsv(rows), `portfolio-${asOfRaw}.csv`);
}
