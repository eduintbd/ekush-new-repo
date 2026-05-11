// Builds the year-end .xlsx that mirrors F.S March 2026.xlsx (spec §9).
// Sheets in this order: Chart of Accounts, Journals, TB-C, BS., IS., CE,
// Notes., Annexure march. Header / formula structure replicated cell-for-
// cell so the auditor opens the file and sees the workbook they expect.
//
// Implementation uses exceljs (already a dep). Formulas are written as
// strings; Excel/LibreOffice recalculates on open.

import ExcelJS from "exceljs";
import { prisma } from "@/lib/prisma";
import { getStatements } from "@/lib/statements";
import { buildNotes, type Note } from "@/lib/notes";
import { getNotesData } from "@/lib/notes-data";
import { getAnnexureB, type AnnexureB } from "@/lib/annexures";

const HEADER_FILL: ExcelJS.FillPattern = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FFE5E7EB" },
};

const BDT_FORMAT = "#,##0.00;[Red]-#,##0.00;\"—\"";

export async function buildYearEndWorkbook(fiscalYearId: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Ekush ERP X-System";
  wb.created = new Date();

  const {
    fiscalYear: fy,
    tbMap,
    external,
    incomeStatement: is1,
    balanceSheet: bs,
  } = await getStatements(fiscalYearId);
  const accounts = await prisma.chartOfAccount.findMany({ orderBy: { sl: "asc" } });
  const journals = await prisma.journal.findMany({
    where: { fiscalYearId },
    orderBy: [{ entryDate: "asc" }, { batchId: "asc" }],
  });

  // --- Sheet 1: Chart of Accounts -------------------------------------
  const coa = wb.addWorksheet("Chart of Accounts");
  coa.columns = [
    { header: "SL.", key: "sl", width: 6 },
    { header: "Accounts Name", key: "name", width: 50 },
    { header: "Normal Balance", key: "nb", width: 18 },
  ];
  coa.getRow(1).font = { bold: true };
  coa.getRow(1).fill = HEADER_FILL;
  for (const a of accounts) {
    coa.addRow({ sl: a.sl, name: a.name, nb: a.normalBalance });
  }

  // --- Sheet 2: Journals ----------------------------------------------
  const j = wb.addWorksheet("Journals");
  // Spec §9: header at row 7. Rows 1–6 reserved for "check of" cells.
  j.getCell("A1").value = "Σ debit";
  j.getCell("B1").value = { formula: `SUM(H8:H${7 + journals.length})` };
  j.getCell("A2").value = "Σ credit";
  j.getCell("B2").value = { formula: `SUM(I8:I${7 + journals.length})` };
  j.getCell("A3").value = "Diff";
  j.getCell("B3").value = { formula: "B1-B2" };

  const headerRow = j.getRow(7);
  ["Year", "Month", "Day", "Date", "Transaction", "Transaction Type", "Account Name", "Debit", "Credit"].forEach(
    (h, i) => {
      const cell = headerRow.getCell(i + 1);
      cell.value = h;
      cell.font = { bold: true };
      cell.fill = HEADER_FILL;
    },
  );
  let r = 8;
  for (const entry of journals) {
    const year = entry.entryDate.getUTCFullYear();
    const month = entry.entryDate.getUTCMonth() + 1;
    const day = entry.entryDate.getUTCDate();
    const row = j.getRow(r);
    row.getCell(1).value = year;
    row.getCell(2).value = month;
    row.getCell(3).value = day;
    row.getCell(4).value = { formula: `DATE(A${r},B${r},C${r})` };
    row.getCell(5).value = entry.description ?? "";
    row.getCell(6).value = entry.txnType ?? "j";
    row.getCell(7).value = entry.accountName;
    row.getCell(8).value = Number(entry.debit) || 0;
    row.getCell(9).value = Number(entry.credit) || 0;
    row.getCell(8).numFmt = BDT_FORMAT;
    row.getCell(9).numFmt = BDT_FORMAT;
    r++;
  }
  j.getColumn(7).width = 38;
  j.getColumn(5).width = 40;

  // --- Sheet 3: TB-C ---------------------------------------------------
  const tb = wb.addWorksheet("TB-C");

  // Rows 5–8: period inputs (mirrors source workbook's E7/E8 date math).
  tb.getCell("A5").value = "Beginning";
  tb.getCell("B5").value = fy.startsOn.getUTCFullYear();
  tb.getCell("C5").value = fy.startsOn.getUTCMonth() + 1;
  tb.getCell("D5").value = fy.startsOn.getUTCDate();
  tb.getCell("E5").value = { formula: "DATE(B5,C5,D5)-1" };

  tb.getCell("A6").value = "Ending";
  tb.getCell("B6").value = fy.endsOn.getUTCFullYear();
  tb.getCell("C6").value = fy.endsOn.getUTCMonth() + 1;
  tb.getCell("D6").value = fy.endsOn.getUTCDate();
  tb.getCell("E6").value = { formula: "DATE(B6,C6,D6)+1" };

  const tbHeader = tb.getRow(7);
  ["", "", "", "", "", "", "Accounts", "Debit", "Credit", "", "Net Debit (K)", "Net Credit (L)"].forEach(
    (h, i) => {
      const c = tbHeader.getCell(i + 1);
      c.value = h;
      if (h) {
        c.font = { bold: true };
        c.fill = HEADER_FILL;
      }
    },
  );

  // Rows 8+: one row per account with SUMIFS formulas
  const journalRange = `Journals!$D$8:$D$${7 + Math.max(journals.length, 1)}`;
  const accountRange = `Journals!$G$8:$G$${7 + Math.max(journals.length, 1)}`;
  const debitRange = `Journals!$H$8:$H$${7 + Math.max(journals.length, 1)}`;
  const creditRange = `Journals!$I$8:$I$${7 + Math.max(journals.length, 1)}`;

  let tbRow = 8;
  for (const acc of accounts) {
    const row = tb.getRow(tbRow);
    const safeName = acc.name.replace(/"/g, '""');
    row.getCell(7).value = acc.name;
    row.getCell(8).value = {
      formula: `MAX(0,SUMIFS(${debitRange},${journalRange},">"&$E$5,${journalRange},"<"&$E$6,${accountRange},"${safeName}"))`,
    };
    row.getCell(9).value = {
      formula: `MAX(0,SUMIFS(${creditRange},${journalRange},">"&$E$5,${journalRange},"<"&$E$6,${accountRange},"${safeName}"))`,
    };
    row.getCell(11).value = { formula: `H${tbRow}-I${tbRow}` };
    row.getCell(12).value = { formula: `I${tbRow}-H${tbRow}` };
    [8, 9, 11, 12].forEach((c) => (row.getCell(c).numFmt = BDT_FORMAT));
    tbRow++;
  }
  // Totals
  const totalRow = tb.getRow(tbRow);
  totalRow.getCell(7).value = "TOTAL";
  totalRow.getCell(7).font = { bold: true };
  totalRow.getCell(11).value = { formula: `SUM(K8:K${tbRow - 1})` };
  totalRow.getCell(12).value = { formula: `SUM(L8:L${tbRow - 1})` };
  totalRow.getCell(11).numFmt = BDT_FORMAT;
  totalRow.getCell(12).numFmt = BDT_FORMAT;
  totalRow.getCell(11).font = { bold: true };
  totalRow.getCell(12).font = { bold: true };
  tb.getColumn(7).width = 50;

  // --- Sheets 4-6: BS / IS / CE — computed values via mapping ---------
  // The workbook formulas are reproducible from TB-C, but the spec also
  // lets us emit the resolved values directly. We emit computed numbers so
  // the file opens with no #REF! even if external links break.
  writeStatementSheet(wb, "IS.", "Statement of Profit or Loss and Other Comprehensive Income", [
    { section: "Operating Income", lines: is1.operatingIncome },
    { section: "Operating Expenses", lines: is1.operatingExpenses },
    { section: "Financial Expenses", lines: is1.financialExpenses },
    { section: "Profit Before Tax", lines: [{ label: "Profit Before Tax", amount: is1.profitBeforeTax }] },
    { section: "Tax", lines: is1.taxExpense },
    { section: "Profit For Period", lines: [{ label: "Profit For Period", amount: is1.profitForPeriod }] },
    { section: "Other Comprehensive Income", lines: is1.oci },
    { section: "Total Comprehensive Income", lines: [{ label: "Total Comprehensive Income", amount: is1.totalComprehensiveIncome }] },
  ]);

  writeStatementSheet(wb, "BS.", "Statement of Financial Position", [
    { section: "Non-Current Assets", lines: bs.nonCurrentAssets },
    { section: "Current Assets", lines: bs.currentAssets },
    { section: "Total Assets", lines: [{ label: "Total Assets", amount: bs.totalAssets }] },
    { section: "Equity", lines: bs.equity },
    { section: "Non-Current Liabilities", lines: bs.nonCurrentLiabilities },
    { section: "Current Liabilities", lines: bs.currentLiabilities },
    { section: "Total Equity & Liabilities", lines: [{ label: "Total Equity & Liabilities", amount: bs.totalEquityAndLiabilities }] },
  ]);

  // Notes. — full notes 4.00 to 27.00, mirrors the /notes page.
  const notesData = await getNotesData(fiscalYearId);
  const notes = buildNotes({
    tb: tbMap,
    incomeStatement: is1,
    balanceSheet: bs,
    external,
    data: notesData,
  });
  writeNotesSheet(wb, notes);

  // Annexure march — Annexure-B (Investments) from InvestmentHolding.
  const annexureB = await getAnnexureB(fiscalYearId);
  writeAnnexureMarchSheet(wb, annexureB);

  // CE — placeholder until equity_movements schema lands.
  const ce = wb.addWorksheet("CE");
  ce.getCell("A1").value = "CE — placeholder. Fill out as schema lands.";
  ce.getCell("A1").font = { italic: true, color: { argb: "FF6B7280" } };

  return Buffer.from(await wb.xlsx.writeBuffer());
}

function writeStatementSheet(
  wb: ExcelJS.Workbook,
  name: string,
  title: string,
  sections: Array<{ section: string; lines: Array<{ label: string; amount: number }> }>,
) {
  const sh = wb.addWorksheet(name);
  sh.getCell("A1").value = "Ekush Wealth Management Limited";
  sh.getCell("A1").font = { bold: true, size: 12 };
  sh.getCell("A2").value = title;
  sh.getCell("A2").font = { bold: true };

  let r = 4;
  for (const sec of sections) {
    sh.getCell(`A${r}`).value = sec.section;
    sh.getCell(`A${r}`).font = { bold: true };
    sh.getCell(`A${r}`).fill = HEADER_FILL;
    r++;
    for (const line of sec.lines) {
      sh.getCell(`B${r}`).value = line.label;
      sh.getCell(`G${r}`).value = line.amount;
      sh.getCell(`G${r}`).numFmt = BDT_FORMAT;
      r++;
    }
    r++;
  }

  sh.getColumn(1).width = 4;
  sh.getColumn(2).width = 50;
  sh.getColumn(7).width = 22;
}

function writeNotesSheet(wb: ExcelJS.Workbook, notes: Note[]) {
  const sh = wb.addWorksheet("Notes.");
  sh.getCell("A1").value = "Ekush Wealth Management Limited";
  sh.getCell("A1").font = { bold: true, size: 12 };
  sh.getCell("A2").value = "Notes to the Financial Statements";
  sh.getCell("A2").font = { bold: true };

  let r = 4;
  for (const n of notes) {
    sh.getCell(`A${r}`).value = n.number;
    sh.getCell(`A${r}`).font = { bold: true };
    sh.getCell(`B${r}`).value = n.reference ? `${n.title}   ${n.reference}` : n.title;
    sh.getCell(`B${r}`).font = { bold: true };
    sh.getCell(`B${r}`).fill = HEADER_FILL;
    r++;
    for (const row of n.rows) {
      sh.getCell(`B${r}`).value = row.indent ? `   ${row.label}` : row.label;
      if (row.subtotal) sh.getCell(`B${r}`).font = { bold: true };
      if (row.amount !== undefined) {
        sh.getCell(`G${r}`).value = row.amount;
        sh.getCell(`G${r}`).numFmt = BDT_FORMAT;
        if (row.subtotal) sh.getCell(`G${r}`).font = { bold: true };
      }
      r++;
    }
    if (n.total !== undefined) {
      sh.getCell(`B${r}`).value = "Total";
      sh.getCell(`B${r}`).font = { bold: true };
      sh.getCell(`G${r}`).value = n.total;
      sh.getCell(`G${r}`).numFmt = BDT_FORMAT;
      sh.getCell(`G${r}`).font = { bold: true };
      r++;
    }
    if (n.needsInputs && n.needsInputs.length > 0) {
      sh.getCell(`B${r}`).value = `Inputs needed: ${n.needsInputs.join("; ")}`;
      sh.getCell(`B${r}`).font = { italic: true, color: { argb: "FF92400E" } };
      r++;
    }
    r++;
  }

  sh.getColumn(1).width = 6;
  sh.getColumn(2).width = 60;
  sh.getColumn(7).width = 22;
}

function writeAnnexureMarchSheet(wb: ExcelJS.Workbook, ax: AnnexureB) {
  const sh = wb.addWorksheet("Annexure march");
  sh.getCell("H1").value = "Annexure-B";
  sh.getCell("H1").font = { bold: true };
  sh.getCell("B2").value = "Ekush Wealth Management Limited";
  sh.getCell("B2").font = { bold: true };
  sh.getCell("B3").value = "Investments";
  sh.getCell("B3").font = { bold: true };
  sh.getCell("B4").value = ax.asOfDate
    ? `As at ${ax.asOfDate.toISOString().slice(0, 10)}`
    : "No holdings recorded";

  const headerRow = sh.getRow(5);
  ["", "Instrument Name", "Quantity", "Average Cost (Q.)", "Total Cost", "Market Rate (Q.)", "Market Value", "Unrealised Gain/(Loss)"].forEach(
    (h, i) => {
      const cell = headerRow.getCell(i + 1);
      cell.value = h;
      if (h) {
        cell.font = { bold: true };
        cell.fill = HEADER_FILL;
      }
    },
  );

  let r = 6;
  for (const g of ax.groups) {
    if (g.rows.length === 0) continue;
    sh.getCell(`A${r}`).value = g.label;
    sh.getCell(`A${r}`).font = { bold: true };
    r++;
    for (const row of g.rows) {
      sh.getCell(`B${r}`).value = row.instrumentName;
      sh.getCell(`C${r}`).value = row.quantity;
      sh.getCell(`D${r}`).value = row.avgCostPerUnit;
      sh.getCell(`E${r}`).value = row.totalCost;
      sh.getCell(`F${r}`).value = row.marketRatePerUnit;
      sh.getCell(`G${r}`).value = row.marketValue;
      sh.getCell(`H${r}`).value = row.unrealisedGain;
      [`D${r}`, `E${r}`, `F${r}`, `G${r}`, `H${r}`].forEach((c) => {
        sh.getCell(c).numFmt = BDT_FORMAT;
      });
      r++;
    }
    // Subtotal row
    sh.getCell(`B${r}`).value = `Subtotal — ${g.label}`;
    sh.getCell(`B${r}`).font = { italic: true };
    sh.getCell(`E${r}`).value = g.subtotals.totalCost;
    sh.getCell(`G${r}`).value = g.subtotals.marketValue;
    sh.getCell(`H${r}`).value = g.subtotals.unrealisedGain;
    [`E${r}`, `G${r}`, `H${r}`].forEach((c) => {
      sh.getCell(c).numFmt = BDT_FORMAT;
      sh.getCell(c).font = { italic: true };
    });
    r++;
  }

  if (ax.groups.every((g) => g.rows.length === 0)) {
    sh.getCell(`B${r}`).value = "No investment holdings recorded for this fiscal year.";
    sh.getCell(`B${r}`).font = { italic: true, color: { argb: "FF6B7280" } };
    r++;
  } else {
    // Grand total
    sh.getCell(`B${r}`).value = "Grand Total";
    sh.getCell(`B${r}`).font = { bold: true };
    sh.getCell(`E${r}`).value = ax.totals.totalCost;
    sh.getCell(`G${r}`).value = ax.totals.marketValue;
    sh.getCell(`H${r}`).value = ax.totals.unrealisedGain;
    [`E${r}`, `G${r}`, `H${r}`].forEach((c) => {
      sh.getCell(c).numFmt = BDT_FORMAT;
      sh.getCell(c).font = { bold: true };
    });
  }

  sh.getColumn(1).width = 22;
  sh.getColumn(2).width = 32;
  for (const col of [3, 4, 5, 6, 7, 8]) sh.getColumn(col).width = 16;
}
