/* eslint-disable */
// One-off diagnostic: list every active portfolio holding and tell you
// which ones DON'T have a Price row ≤ today (or a passed --asOf date).
// Run: npx tsx scripts/diag-portfolio-prices.ts [--asOf=YYYY-MM-DD]

import { config } from "dotenv";
config({ path: ".env" });

import { PrismaClient } from "@/generated/prisma";
import { buildPortfolioAsOf, fromPrismaTrades, latestPricesMap } from "@/lib/portfolio";

const prisma = new PrismaClient();

async function main() {
  const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
      const [k, v] = a.replace(/^--/, "").split("=");
      return [k, v ?? "true"];
    }),
  );
  const asOfRaw = args.asOf ?? new Date().toISOString().slice(0, 10);
  const asOf = new Date(`${asOfRaw}T00:00:00Z`);

  console.log(`As of ${asOfRaw}`);
  console.log("");

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

  console.log(`Active holdings (qty > 0): ${portfolio.length}`);
  console.log("");
  console.log("Status".padEnd(8) + "Code".padEnd(14) + "Qty".padStart(14) + "  Latest price ≤ asOf");
  console.log("".padEnd(80, "─"));

  const missing: string[] = [];
  for (const r of portfolio) {
    const inst = instMap.get(r.instrumentCode);
    const status = r.unrealisedPnl === null ? "✗ MISS" : "  ✓";
    const priceStr =
      r.unrealisedPnl === null
        ? "(no price)"
        : `${r.marketRate?.toFixed(4)} on ${r.priceDate?.toISOString().slice(0, 10)}`;
    console.log(
      status.padEnd(8) +
        r.instrumentCode.padEnd(14) +
        r.quantity.toLocaleString("en-IN").padStart(14) +
        "  " +
        priceStr +
        (inst ? `  (${inst.isActive ? "active" : "INACTIVE"}, ${inst.category})` : ""),
    );
    if (r.unrealisedPnl === null) missing.push(r.instrumentCode);
  }

  console.log("");
  if (missing.length === 0) {
    console.log("✓ Every holding has a price. The 'Revalue to market' button should be visible.");
  } else {
    console.log(`✗ ${missing.length} instrument(s) missing a price ≤ ${asOfRaw}:`);
    console.log(`   ${missing.join(", ")}`);
    console.log("");
    console.log("Open /prices on the live site, pick the date, type any close price for these,");
    console.log("hit Save, then hard-refresh /portfolio — button should appear.");
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
