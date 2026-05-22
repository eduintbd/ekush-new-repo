/* eslint-disable */
import { config } from "dotenv";
config({ path: ".env" });

import { PrismaClient } from "@/generated/prisma";
import { buildPortfolioAsOf, fromPrismaTrades, latestPricesMap } from "@/lib/portfolio";

const prisma = new PrismaClient();

async function main() {
  const asOf = new Date("2026-03-31T00:00:00Z");

  const tradeCount = await prisma.trade.count();
  console.log(`Total Trade rows: ${tradeCount}`);

  const buyCount = await prisma.trade.count({ where: { side: "BUY" } });
  const sellCount = await prisma.trade.count({ where: { side: "SELL" } });
  console.log(`  BUYs: ${buyCount}`);
  console.log(`  SELLs: ${sellCount}`);

  // Portfolio as of Mar 31, 2026
  const [trades, prices] = await Promise.all([
    prisma.trade.findMany({
      where: { tradeDate: { lte: asOf } },
      orderBy: [{ tradeDate: "asc" }, { createdAt: "asc" }],
    }),
    prisma.price.findMany({ where: { priceDate: { lte: asOf } } }),
  ]);
  const portfolio = buildPortfolioAsOf(fromPrismaTrades(trades), latestPricesMap(prices), asOf);

  console.log(`\nPortfolio as of 2026-03-31 (${portfolio.length} positions with non-zero qty):`);
  console.log("Instrument".padEnd(15) + "  qty".padStart(14) + "  avgCost".padStart(12) + "  totalCost".padStart(18));
  let totalCost = 0;
  for (const r of portfolio) {
    console.log(
      r.instrumentCode.padEnd(15) +
      r.quantity.toLocaleString("en-IN").padStart(14) +
      r.avgCost.toFixed(4).padStart(12) +
      r.totalCost.toLocaleString("en-IN", { minimumFractionDigits: 2 }).padStart(18)
    );
    totalCost += r.totalCost;
  }
  console.log(`\nTotal cost basis: ${totalCost.toLocaleString("en-IN", { minimumFractionDigits: 2 })}`);

  // Sum realised P&L across all SELL trades
  const sells = await prisma.trade.findMany({ where: { side: "SELL" } });
  let realisedPnl = 0;
  for (const s of sells) realisedPnl += Number(s.realisedPnl ?? 0);
  console.log(`Realised P&L across all sells (Jul-Mar): ${realisedPnl.toLocaleString("en-IN", { minimumFractionDigits: 2 })}`);

  // For comparison, workbook Pinki snapshot: total cost 68,396,780.80, market value 78,057,655.36
  console.log(`\nWorkbook Pinki snapshot (target): cost 6,83,96,780.80; market 7,80,57,655.36`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
