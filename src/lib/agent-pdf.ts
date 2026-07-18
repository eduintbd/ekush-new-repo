// jsPDF statement builders for the agent portal. Self-contained (no Puppeteer):
// clean, branded tabular PDFs generated from the shared DB. Per the requirement
// the agent just needs the downloadable PDF, not an on-screen breakdown.

import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import type {
  HoldingRow,
  TxnRow,
  DividendRow,
  TaxCertRow,
} from "@/lib/portal-statements";

export interface StatementInvestor {
  name: string;
  investorCode: string;
  jointApplicantName?: string | null;
}

const BRAND: [number, number, number] = [28, 25, 23]; // zinc-900

function num(n: number, dp = 2): string {
  return (n ?? 0).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
function d(v: Date | null | undefined): string {
  return v ? new Date(v).toISOString().slice(0, 10) : "—";
}

function header(doc: jsPDF, title: string, investor: StatementInvestor, fundCode?: string): number {
  doc.setFontSize(15);
  doc.setTextColor(...BRAND);
  doc.text("Ekush Wealth Management Limited", 14, 16);
  doc.setFontSize(11);
  doc.setTextColor(90, 90, 90);
  doc.text(title, 14, 23);

  doc.setFontSize(9);
  doc.setTextColor(60, 60, 60);
  const holder = investor.jointApplicantName
    ? `${investor.name} & ${investor.jointApplicantName}`
    : investor.name;
  doc.text(`Investor: ${holder}  (${investor.investorCode})`, 14, 31);
  doc.text(`Fund: ${fundCode ?? "All funds"}`, 14, 36);
  doc.text(`Generated: ${new Date().toISOString().slice(0, 10)}`, 14, 41);
  doc.setDrawColor(220, 220, 220);
  doc.line(14, 44, 196, 44);
  return 48;
}

function toBytes(doc: jsPDF): Uint8Array {
  return new Uint8Array(doc.output("arraybuffer"));
}

export function portfolioPdf(
  investor: StatementInvestor,
  rows: HoldingRow[],
  fundCode?: string,
): Uint8Array {
  const doc = new jsPDF();
  const startY = header(doc, "Portfolio Statement", investor, fundCode);
  autoTable(doc, {
    startY,
    head: [["Fund", "Units", "Avg cost", "NAV", "Cost value", "Market value", "Unrealized", "Realized"]],
    body: rows.map((r) => [
      r.fundCode,
      num(r.totalCurrentUnits, 4),
      num(r.avgCost, 4),
      num(r.nav, 4),
      num(r.totalCostValueCurrent),
      num(r.totalMarketValue),
      num(r.totalUnrealizedGain),
      num(r.totalRealizedGain),
    ]),
    foot: rows.length
      ? [[
          "Total", "", "", "",
          num(rows.reduce((s, r) => s + r.totalCostValueCurrent, 0)),
          num(rows.reduce((s, r) => s + r.totalMarketValue, 0)),
          num(rows.reduce((s, r) => s + r.totalUnrealizedGain, 0)),
          num(rows.reduce((s, r) => s + r.totalRealizedGain, 0)),
        ]]
      : undefined,
    styles: { fontSize: 8, cellPadding: 2 },
    headStyles: { fillColor: BRAND },
    footStyles: { fillColor: [240, 240, 240], textColor: BRAND, fontStyle: "bold" },
    columnStyles: { 0: { halign: "left" } },
    theme: "striped",
    didParseCell: (h) => {
      if (h.column.index > 0) h.cell.styles.halign = "right";
    },
  });
  if (!rows.length) doc.text("No holdings on record.", 14, startY + 8);
  return toBytes(doc);
}

export function transactionsPdf(
  investor: StatementInvestor,
  rows: TxnRow[],
  fundCode?: string,
): Uint8Array {
  const doc = new jsPDF();
  const startY = header(doc, "Transaction Statement", investor, fundCode);
  autoTable(doc, {
    startY,
    head: [["Date", "Fund", "Type", "Channel", "Units", "NAV", "Amount", "Cumulative units"]],
    body: rows.map((r) => [
      d(r.orderDate),
      r.fundCode,
      r.direction,
      r.channel,
      num(r.units, 4),
      num(r.nav, 4),
      num(r.amount),
      num(r.cumulativeUnits, 4),
    ]),
    styles: { fontSize: 8, cellPadding: 2 },
    headStyles: { fillColor: BRAND },
    theme: "striped",
    didParseCell: (h) => {
      if (h.column.index >= 4) h.cell.styles.halign = "right";
    },
  });
  if (!rows.length) doc.text("No transactions on record.", 14, startY + 8);
  return toBytes(doc);
}

export function dividendsPdf(
  investor: StatementInvestor,
  rows: DividendRow[],
  fundCode?: string,
): Uint8Array {
  const doc = new jsPDF();
  const startY = header(doc, "Dividend Statement", investor, fundCode);
  autoTable(doc, {
    startY,
    head: [["Year", "Fund", "Paid on", "Units", "Div/unit", "Gross", "Tax", "Net"]],
    body: rows.map((r) => [
      r.accountingYear ?? "—",
      r.fundCode,
      d(r.paymentDate),
      num(r.totalUnits, 4),
      num(r.dividendPerUnit, 4),
      num(r.grossDividend),
      num(r.taxAmount),
      num(r.netDividend),
    ]),
    foot: rows.length
      ? [[
          "Total", "", "", "", "",
          num(rows.reduce((s, r) => s + r.grossDividend, 0)),
          num(rows.reduce((s, r) => s + r.taxAmount, 0)),
          num(rows.reduce((s, r) => s + r.netDividend, 0)),
        ]]
      : undefined,
    styles: { fontSize: 8, cellPadding: 2 },
    headStyles: { fillColor: BRAND },
    footStyles: { fillColor: [240, 240, 240], textColor: BRAND, fontStyle: "bold" },
    theme: "striped",
    didParseCell: (h) => {
      if (h.column.index >= 3) h.cell.styles.halign = "right";
    },
  });
  if (!rows.length) doc.text("No dividends on record.", 14, startY + 8);
  return toBytes(doc);
}

export function taxCertPdf(
  investor: StatementInvestor,
  rows: TaxCertRow[],
  fundCode?: string,
): Uint8Array {
  const doc = new jsPDF();
  const startY = header(doc, "Tax Certificate", investor, fundCode);
  autoTable(doc, {
    startY,
    head: [["Fund", "Period", "Ending units", "Cost value", "Market value", "Realized gain", "Gross div.", "Tax"]],
    body: rows.map((r) => [
      r.fundCode,
      `${d(r.periodStart)} → ${d(r.periodEnd)}`,
      num(r.endingUnits, 4),
      num(r.endingCostValue),
      num(r.endingMarketValue),
      num(r.totalRealizedGain),
      num(r.totalGrossDividend),
      num(r.totalTax),
    ]),
    styles: { fontSize: 8, cellPadding: 2 },
    headStyles: { fillColor: BRAND },
    theme: "striped",
    didParseCell: (h) => {
      if (h.column.index >= 2) h.cell.styles.halign = "right";
    },
  });
  if (!rows.length) doc.text("No tax certificates on record.", 14, startY + 8);
  doc.setFontSize(7);
  doc.setTextColor(140, 140, 140);
  doc.text(
    "Summary generated from Ekush records. The official stamped tax certificate is issued by the office.",
    14,
    285,
  );
  return toBytes(doc);
}
