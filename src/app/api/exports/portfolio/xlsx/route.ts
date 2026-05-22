// GET /api/exports/portfolio/xlsx?asOf=YYYY-MM-DD → .xlsx download.
// Mirrors the Annexure-B / Portfolio_Pinki_1 layout in the source
// workbook so auditors can drop the file straight in.

import { NextResponse, type NextRequest } from "next/server";
import ExcelJS from "exceljs";
import { requireStaff } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { buildPortfolioAsOf, fromPrismaTrades, latestPricesMap } from "@/lib/portfolio";

export const runtime = "nodejs"; // exceljs needs Node, not edge
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
    return NextResponse.json({ error: "asOf=YYYY-MM-DD required" }, { status: 400 });
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
  const byCategory: Record<string, typeof portfolio> = {};
  for (const p of portfolio) {
    const cat = instMap.get(p.instrumentCode)?.category ?? "listed_security";
    (byCategory[cat] ??= []).push(p);
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = "Ekush ERP";
  wb.created = new Date();
  const ws = wb.addWorksheet("Portfolio", {
    properties: { defaultColWidth: 18 },
  });

  // Header block mirroring Portfolio_Pinki_1 rows 1–5.
  ws.mergeCells("B1:I1");
  ws.getCell("I1").value = "Annexure-B";
  ws.getCell("I1").alignment = { horizontal: "right" };
  ws.getCell("I1").font = { bold: true };

  ws.mergeCells("B2:I2");
  ws.getCell("B2").value = "Ekush Wealth Management Ltd";
  ws.getCell("B2").alignment = { horizontal: "center" };
  ws.getCell("B2").font = { bold: true, size: 14 };

  ws.mergeCells("B3:I3");
  ws.getCell("B3").value = "Investments";
  ws.getCell("B3").alignment = { horizontal: "center" };
  ws.getCell("B3").font = { bold: true };

  ws.mergeCells("B4:I4");
  ws.getCell("B4").value = `As at ${asOfRaw}`;
  ws.getCell("B4").alignment = { horizontal: "center" };
  ws.getCell("B4").font = { italic: true };

  const headers = ["", "Instrument Code", "Instrument Name", "Quantity", "Average Cost (Q.)", "Total Cost", "Market Rate (Q.)", "Market Value", "Unrealised Gain/(Loss)"];
  ws.getRow(6).values = headers;
  ws.getRow(6).font = { bold: true };
  ws.getRow(6).alignment = { horizontal: "center" };

  let r = 7;
  let grandCost = 0, grandMarket = 0, grandUnreal = 0;

  for (const cat of CATEGORY_ORDER) {
    const items = byCategory[cat];
    if (!items || items.length === 0) continue;

    // Category header
    ws.mergeCells(`B${r}:I${r}`);
    ws.getCell(`B${r}`).value = CATEGORY_LABEL[cat] ?? cat;
    ws.getCell(`B${r}`).font = { bold: true };
    ws.getCell(`B${r}`).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF1F5F9" } };
    r++;

    let subCost = 0, subMarket = 0, subUnreal = 0;
    for (const p of items) {
      const inst = instMap.get(p.instrumentCode);
      ws.getRow(r).values = [
        "",
        p.instrumentCode,
        inst?.name ?? p.instrumentCode,
        p.quantity,
        p.avgCost,
        p.totalCost,
        p.marketRate ?? "",
        p.marketValue ?? "",
        p.unrealisedPnl ?? "",
      ];
      // Number formats
      ws.getCell(`D${r}`).numFmt = "#,##0.0000";
      ws.getCell(`E${r}`).numFmt = "#,##0.0000";
      ws.getCell(`F${r}`).numFmt = "#,##0.00";
      ws.getCell(`G${r}`).numFmt = "#,##0.0000";
      ws.getCell(`H${r}`).numFmt = "#,##0.00";
      ws.getCell(`I${r}`).numFmt = "#,##0.00;[Red](#,##0.00)";
      subCost += p.totalCost;
      subMarket += p.marketValue ?? 0;
      subUnreal += p.unrealisedPnl ?? 0;
      r++;
    }

    // Subtotal row
    ws.getRow(r).values = ["", "", `Subtotal ${CATEGORY_LABEL[cat]}`, "", "", subCost, "", subMarket, subUnreal];
    ws.getRow(r).font = { bold: true };
    ws.getCell(`F${r}`).numFmt = "#,##0.00";
    ws.getCell(`H${r}`).numFmt = "#,##0.00";
    ws.getCell(`I${r}`).numFmt = "#,##0.00;[Red](#,##0.00)";
    r++;

    grandCost += subCost;
    grandMarket += subMarket;
    grandUnreal += subUnreal;
  }

  // Grand total
  r++;
  ws.getRow(r).values = ["", "", "Total", "", "", grandCost, "", grandMarket, grandUnreal];
  ws.getRow(r).font = { bold: true, size: 12 };
  ws.getCell(`F${r}`).numFmt = "#,##0.00";
  ws.getCell(`H${r}`).numFmt = "#,##0.00";
  ws.getCell(`I${r}`).numFmt = "#,##0.00;[Red](#,##0.00)";

  // Column widths
  ws.getColumn(1).width = 4;
  ws.getColumn(2).width = 18;
  ws.getColumn(3).width = 38;
  ws.getColumn(4).width = 14;
  ws.getColumn(5).width = 16;
  ws.getColumn(6).width = 16;
  ws.getColumn(7).width = 16;
  ws.getColumn(8).width = 18;
  ws.getColumn(9).width = 18;

  const buf = await wb.xlsx.writeBuffer();

  return new NextResponse(buf as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="portfolio-${asOfRaw}.xlsx"`,
      "Cache-Control": "no-store",
    },
  });
}
