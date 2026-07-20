// The branded one-page investor statement ("Investment Update") — the exact
// document portal.ekushwml.com produces, reproduced here so a selling agent
// can download the same thing for the investors they sourced.
//
// Ported from the portal's src/lib/pdf.ts generateInvestmentUpdatePDF, which
// is pure jsPDF and depends on nothing but jspdf/jspdf-autotable (both already
// used here). It is dead code in the portal — that app's "PDF" buttons open a
// print page and rely on the browser's Save-as-PDF — so this is the only place
// the layout is actually rendered to a file.
//
// Deliberately NOT ported via Puppeteer: the portal's HTML→PDF path pulls in
// puppeteer-core + a ~50 MB chromium download at runtime. jsPDF renders the
// same page with no new dependency and no cold-start penalty.
//
// Layout constants (mm, A4) are kept byte-identical to the portal's so the two
// documents stay visually indistinguishable.

import jsPDF from "jspdf";
import { readFileSync } from "fs";
import path from "path";

export interface InvestmentUpdateData {
  investorName: string;
  investorCode: string;
  fundName: string;
  fundCode: string;
  totalUnits: number;
  avgCost: number;
  costValue: number;
  marketValue: number;
  realizedGain: number;
  dividendTotal: number;
  nav: number;
  entryLoad: number; // fractional, e.g. 0.02
  exitLoad: number;
  dateStr: string; // "July 20, 2026"
  bannerPngDataUrl?: string;
}

const FUND_REG_INFO: Record<string, string> = {
  EFUF: "BSEC/Mutual Fund/2019/106",
  EGF: "BSEC/Mutual Fund/2022/129",
  ESRF: "BSEC/Mutual Fund/2022/130",
};

let bannerCache: string | null | undefined;

/** public/banner_for_portfolio.png as a data URL, read once per process. */
export function getPortfolioBannerDataUrl(): string | null {
  if (bannerCache !== undefined) return bannerCache;
  try {
    const buf = readFileSync(path.join(process.cwd(), "public", "banner_for_portfolio.png"));
    bannerCache = `data:image/png;base64,${buf.toString("base64")}`;
  } catch {
    // Missing asset must not break the download — the page just renders
    // without its header strip.
    bannerCache = null;
  }
  return bannerCache;
}

/** "July 20, 2026" — matches the portal's header format. */
export function statementDateStr(d: Date = new Date()): string {
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

/**
 * Draw one branded statement page into `doc`. Returns the same doc so pages
 * can be chained for a multi-fund download.
 */
export function drawInvestmentUpdate(doc: jsPDF, data: InvestmentUpdateData): jsPDF {
  const pageWidth = doc.internal.pageSize.getWidth(); // 210
  const pageHeight = doc.internal.pageSize.getHeight(); // 297

  // ── Banner
  let bannerBottomY = 8;
  if (data.bannerPngDataUrl) {
    try {
      // Source banner is ~1584x331 ≈ 4.79 aspect; fit to full width.
      const bannerHeight = pageWidth / 4.79;
      doc.addImage(data.bannerPngDataUrl, "PNG", 0, 0, pageWidth, bannerHeight);
      bannerBottomY = bannerHeight;
    } catch {
      bannerBottomY = 8;
    }
  }

  const leftX = 22;
  const rightX = pageWidth - 22;
  let y = bannerBottomY + 8;

  doc.setTextColor(0, 0, 0);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  doc.text(data.dateStr, leftX, y);
  y += 10;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.text(data.investorName, leftX, y);
  y += 5;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  doc.text(`Investor Code: ${data.investorCode}`, leftX, y);
  y += 8;

  // ── Fund info box
  const boxX = leftX;
  const boxW = rightX - leftX;
  const boxY = y;
  const boxH = 38;
  doc.setFillColor(240, 240, 240);
  doc.setDrawColor(204, 204, 204);
  doc.rect(boxX, boxY, boxW, boxH, "FD");

  doc.setFont("helvetica", "bold");
  doc.setFontSize(12.5);
  doc.setTextColor(0, 0, 0);
  doc.text(data.fundName.toUpperCase(), pageWidth / 2, boxY + 6, { align: "center" });

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.8);
  doc.setTextColor(68, 68, 68);
  doc.text(
    "Registered under the Bangladesh Securities & Exchange Commission (Mutual Fund) Rules, 2001.",
    pageWidth / 2,
    boxY + 11,
    { align: "center" },
  );

  const regNo = FUND_REG_INFO[data.fundCode] || FUND_REG_INFO.EFUF;
  const rows: Array<[string, string]> = [
    ["Registration No", regNo],
    ["Sponsor", "Ekush Wealth Management Limited"],
    ["Asset Manager", "Ekush Wealth Management Limited"],
    ["Trustee", "Sandhani Life Insurance Co. Ltd"],
    ["Custodian", "BRAC Bank Limited"],
  ];
  doc.setTextColor(0, 0, 0);
  doc.setFontSize(9);
  let ry = boxY + 17;
  const labelX = pageWidth / 2 - 35;
  const colonX = labelX + 40;
  const valueX = colonX + 3;
  for (const [label, value] of rows) {
    doc.setFont("helvetica", "bold");
    doc.text(label, labelX, ry);
    doc.setFont("helvetica", "normal");
    doc.text(":", colonX, ry);
    doc.text(value, valueX, ry);
    ry += 4;
  }

  y = boxY + boxH + 5;

  // ── Units / Avg cost
  const colW = boxW / 4;
  doc.setDrawColor(0, 0, 0);
  doc.setLineWidth(0.6);
  doc.line(leftX, y, rightX, y);
  doc.setLineWidth(0.2);
  doc.line(leftX, y + 8, rightX, y + 8);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.text("Number of Units", leftX + 2, y + 5);
  doc.text("Average Cost/Unit", leftX + 2 * colW + 2, y + 5);

  doc.setFont("helvetica", "normal");
  doc.text(
    data.totalUnits.toLocaleString("en-IN", { maximumFractionDigits: 0 }),
    leftX + 2 * colW - 2,
    y + 5,
    { align: "right" },
  );
  doc.text(data.avgCost.toFixed(3), rightX - 2, y + 5, { align: "right" });
  y += 12;

  // ── Investment Results
  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  doc.text("Investment Results:", leftX, y);
  doc.setLineWidth(0.5);
  doc.line(leftX, y + 1.2, rightX, y + 1.2);
  doc.line(leftX, y + 2.0, rightX, y + 2.0);
  y += 6;

  const halfW = boxW / 2;
  const valueRightL = leftX + halfW - 4;
  const rowHeight = 6.5;
  const fmt = (n: number) =>
    n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const resultRows: Array<[string, number, string, number, boolean]> = [
    ["Cost Value of Investment", data.costValue, "Capital Gain on Unit Sold", data.realizedGain, false],
    ["Wealth increased by", data.marketValue - data.costValue, "Dividend Received", data.dividendTotal, false],
    [
      "Current Value of Investment",
      data.marketValue,
      "Total Value Creation",
      data.marketValue - data.costValue + data.realizedGain + data.dividendTotal,
      true,
    ],
  ];

  doc.setLineWidth(0.2);
  for (const [lLabel, lVal, rLabel, rVal, totalsRow] of resultRows) {
    if (totalsRow) {
      doc.setFillColor(240, 240, 240);
      doc.rect(leftX + halfW, y - rowHeight + 1.5, halfW, rowHeight, "F");
    }
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9.5);
    doc.setTextColor(0, 0, 0);
    doc.text(lLabel, leftX, y);
    doc.setFont("helvetica", "bold");
    doc.text(fmt(lVal), valueRightL, y, { align: "right" });

    doc.setFont("helvetica", totalsRow ? "italic" : "normal");
    doc.text(rLabel, leftX + halfW + 2, y);
    doc.setFont("helvetica", totalsRow ? "bolditalic" : "bold");
    doc.text(fmt(rVal), rightX, y, { align: "right" });
    doc.setFont("helvetica", "normal");

    doc.line(leftX, y + 1.2, rightX, y + 1.2);
    y += rowHeight;
  }

  y += 5;

  // ── NAV paragraph + table
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(0, 0, 0);
  const navPara = doc.splitTextToSize(
    "The current Net Asset Value (NAV) per unit, together with the applicable buy and sale prices of the fund, is presented below:",
    boxW,
  );
  doc.text(navPara, leftX, y);
  y += navPara.length * 4.8 + 4;

  const navTableW = boxW * 0.8;
  const navTableX = (pageWidth - navTableW) / 2;
  const navColW = navTableW / 3;

  doc.setFillColor(240, 240, 240);
  doc.rect(navTableX, y, navTableW, 9, "F");
  doc.setLineWidth(0.6);
  doc.line(navTableX, y, navTableX + navTableW, y);
  doc.line(navTableX, y + 9, navTableX + navTableW, y + 9);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.text("NAV", navTableX + navColW / 2, y + 6, { align: "center" });
  doc.text("Buy Price", navTableX + navColW + navColW / 2, y + 6, { align: "center" });
  doc.text("Sale Price", navTableX + 2 * navColW + navColW / 2, y + 6, { align: "center" });
  y += 9;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  const buyPrice = data.nav * (1 + (data.entryLoad || 0));
  const sellPrice = data.nav * (1 - (data.exitLoad || 0));
  doc.text(data.nav.toFixed(3), navTableX + navColW / 2, y + 6, { align: "center" });
  doc.text(buyPrice.toFixed(3), navTableX + navColW + navColW / 2, y + 6, { align: "center" });
  doc.text(sellPrice.toFixed(3), navTableX + 2 * navColW + navColW / 2, y + 6, { align: "center" });
  doc.setLineWidth(0.6);
  doc.line(navTableX, y + 9, navTableX + navTableW, y + 9);

  // ── Orange footer strip
  const footerH = 10;
  const footerY = pageHeight - footerH;
  doc.setFillColor(242, 112, 35);
  doc.rect(0, footerY, pageWidth, footerH, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.5);
  doc.text("+8801713-086101", 6, footerY + 4.5);
  doc.text("info@ekushwml.com", 44, footerY + 4.5);
  doc.text(
    "Apt-A3, House: 17, Road: 01, Block: A, Niketon, Gulshan 01, Dhaka-1212",
    pageWidth / 2,
    footerY + 4.5,
    { align: "center" },
  );
  doc.text("www.ekushwml.com", pageWidth - 6, footerY + 4.5, { align: "right" });

  return doc;
}

/**
 * One branded page per fund. An investor holding three funds gets a
 * three-page PDF, matching what the portal produces per fund.
 */
export function investmentUpdatePdf(
  investor: { name: string; investorCode: string; jointApplicantName?: string | null },
  rows: InvestmentUpdateData[],
): Uint8Array {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  rows.forEach((row, i) => {
    if (i > 0) doc.addPage();
    drawInvestmentUpdate(doc, row);
  });
  if (rows.length === 0) {
    doc.setFontSize(12);
    doc.text("No holdings to report.", 22, 40);
  }
  return new Uint8Array(doc.output("arraybuffer"));
}
