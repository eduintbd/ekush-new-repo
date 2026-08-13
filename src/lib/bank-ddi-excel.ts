// Bank auto-debit (DDI / SIP) mandate spreadsheet.
//
// Ported verbatim from apps/portal/src/lib/bank-excel.ts. This is the exact
// upload format the collection bank expects for its monthly auto-debit pull:
// one header row + one data row, eleven columns, every value stored as TEXT so
// leading zeros in account / routing / mobile numbers survive.
//
// It is copied rather than shared because the two apps are separate
// deployments with no common package — so if the bank ever changes its
// template, BOTH files must change. The layout constants below are the
// contract with the bank, not styling preferences.

import ExcelJS from "exceljs";

export type BankDdiRow = {
  mandateReference: string;
  debitAccountName: string;
  debitAccountNumber: string;
  routingNumber: string;
  amount: string;
  creditNarration: string;
  /** "Monthly" for a SIP, "INSTANT" for a one-time DDI. */
  cycleType: string;
  /** "DD/MM/YYYY" for a SIP; "" for a one-time DDI. */
  siStartDate: string;
  siEndDate: string;
  receiverEmail: string;
  receiverMobile: string;
};

// Header fills mirror the bank's own template: green for the mandate/amount
// block, blue for the schedule dates, orange for the receiver contact block.
const GREEN = "FF92D050";
const BLUE = "FFBDD7EE";
const ORANGE = "FFFFC000";

const COLS: Array<{ header: string; width: number; fill: string; key: keyof BankDdiRow }> = [
  { header: "Mandate Reference ID", width: 18, fill: GREEN, key: "mandateReference" },
  { header: "Debit Account Name", width: 32, fill: GREEN, key: "debitAccountName" },
  { header: "Debit Account Number", width: 22, fill: GREEN, key: "debitAccountNumber" },
  { header: "Routing Number", width: 16, fill: GREEN, key: "routingNumber" },
  { header: "Amount (BDT)", width: 14, fill: GREEN, key: "amount" },
  { header: "Credit Narration", width: 18, fill: GREEN, key: "creditNarration" },
  { header: "Cycle Type", width: 12, fill: GREEN, key: "cycleType" },
  { header: "SI Start Date\n(DD/MM/YYYY)", width: 13, fill: BLUE, key: "siStartDate" },
  { header: "SI End Date\n(DD/MM/YYYY)", width: 13, fill: BLUE, key: "siEndDate" },
  { header: "Receiver's Email", width: 34, fill: ORANGE, key: "receiverEmail" },
  { header: "Receiver's\nMobile Number", width: 20, fill: ORANGE, key: "receiverMobile" },
];

function thin(): Partial<ExcelJS.Borders> {
  const side = { style: "thin" as const, color: { argb: "FFBFBFBF" } };
  return { top: side, left: side, bottom: side, right: side };
}

export async function buildBankDdiExcel(row: BankDdiRow): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Ekush WML";
  wb.created = new Date();
  const ws = wb.addWorksheet("Sheet1");

  const header = ws.getRow(1);
  COLS.forEach((c, i) => {
    ws.getColumn(i + 1).width = c.width;
    const cell = header.getCell(i + 1);
    cell.value = c.header;
    cell.numFmt = "@";
    cell.font = { name: "Arial", size: 10, bold: true };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: c.fill } };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    cell.border = thin();
  });
  header.height = 43.2;

  const data = ws.getRow(2);
  COLS.forEach((c, i) => {
    const cell = data.getCell(i + 1);
    // Force text so "095274188" / "01785977202" keep their leading zero and
    // long account numbers are never rendered in scientific notation.
    cell.numFmt = "@";
    cell.value = row[c.key] ?? "";
    cell.font = { name: "Arial", size: 10 };
    cell.alignment = { vertical: "middle" };
    cell.border = thin();
  });

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf as ArrayBuffer);
}

/** Normalise a stored phone to the local 11-digit 01XXXXXXXXX the bank wants. */
export function bdMobile(phone?: string | null): string {
  if (!phone) return "";
  let s = phone.replace(/\D/g, "");
  if (s.startsWith("880")) s = "0" + s.slice(3);
  else if (s.length === 10 && s.startsWith("1")) s = "0" + s;
  return s;
}

/** Whole BDT with no decimals ("3000"); keeps 2dp only for fractional amounts. */
export function bankAmount(amount: number): string {
  return Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
}

/** DD/MM/YYYY, matching the printed DDI form's en-GB rendering. */
export function fmtDMY(d: Date): string {
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" });
}
