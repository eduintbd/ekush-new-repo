"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import ExcelJS, { type CellRichTextValue, type CellFormulaValue } from "exceljs";
import { prisma, withActor } from "@/lib/prisma";
import { requireRole } from "@/lib/auth";

// Map ekush-portal fund.id → AMC fund code. Resolved at import time via
// a join on public.funds.code.

function cellText(v: ExcelJS.CellValue): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const rt = v as Partial<CellRichTextValue>;
    if (Array.isArray(rt.richText)) return rt.richText.map((p) => p.text).join("");
    const fv = v as Partial<CellFormulaValue>;
    if (fv.result !== undefined) return cellText(fv.result as ExcelJS.CellValue);
  }
  return "";
}

function cellNum(v: ExcelJS.CellValue): number {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "string") return parseFloat(v) || 0;
  if (typeof v === "object") {
    const fv = v as Partial<CellFormulaValue>;
    if (fv.result !== undefined) return cellNum(fv.result as ExcelJS.CellValue);
  }
  return 0;
}

/**
 * Parse a fund's FIN_STATS xlsx and return the period-cumulative
 * Management Fee debit total for (fyStart..reportDate).
 *
 * Workbook structure (confirmed via scripts/peek-fin-stats.ts):
 *   Journals sheet has columns: Year | Month | Day | Value | Date |
 *   Description | TxnType | (blank) | Account Name | Debit | Credit | ...
 * Account name column is G (col 9 in the data) - but the exact column
 * varies between fund books. We resolve by finding the header row and
 * matching column names.
 */
async function parseManagementFeeFromXlsx(
  buffer: ArrayBuffer,
  fyStart: Date,
  reportDate: Date,
): Promise<{ total: number; rowCount: number }> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const sheet = wb.getWorksheet("Journals");
  if (!sheet) throw new Error("Journals sheet not found in FIN_STATS xlsx");

  // Find header row by scanning first 15 rows for "Account Name"
  let headerRow = 0;
  let yearCol = 0;
  let monthCol = 0;
  let dayCol = 0;
  let accountCol = 0;
  let debitCol = 0;
  for (let r = 1; r <= Math.min(15, sheet.rowCount); r++) {
    const row = sheet.getRow(r);
    for (let c = 1; c <= sheet.columnCount; c++) {
      const v = cellText(row.getCell(c).value).toLowerCase();
      if (v === "year") yearCol = c;
      else if (v === "month") monthCol = c;
      else if (v === "day") dayCol = c;
      else if (v.includes("account") && v.includes("name")) accountCol = c;
      else if (v === "debit") debitCol = c;
    }
    if (accountCol && debitCol && yearCol) {
      headerRow = r;
      break;
    }
  }
  if (!headerRow || !accountCol || !debitCol) {
    throw new Error("Could not locate header row in Journals sheet");
  }

  let total = 0;
  let rowCount = 0;
  for (let r = headerRow + 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const account = cellText(row.getCell(accountCol).value).trim();
    if (account.toLowerCase() !== "management fee") continue;

    const year = cellNum(row.getCell(yearCol).value);
    const month = monthCol ? cellNum(row.getCell(monthCol).value) : 0;
    const day = dayCol ? cellNum(row.getCell(dayCol).value) : 0;
    if (!year) continue;

    const entryDate = new Date(Date.UTC(year, (month || 1) - 1, day || 1));
    if (entryDate < fyStart || entryDate > reportDate) continue;

    const debit = cellNum(row.getCell(debitCol).value);
    if (debit > 0) {
      total += debit;
      rowCount += 1;
    }
  }
  return { total, rowCount };
}

/**
 * Pull the latest 3 FIN_STATS uploads (one per fund) and upsert a
 * ManagementFeeImport row for each. Idempotent at the (fund, period)
 * grain — re-running with the same upload re-computes and overwrites
 * the `computedAmount` but preserves any `manualAmount` already set.
 */
export async function runImportLatest(): Promise<void> {
  const me = await requireRole(["admin", "accountant"]);

  // Read funds from public schema
  const funds = await prisma.$queryRawUnsafe<Array<{ id: string; code: string; name: string }>>(
    `SELECT id, code, name FROM public.funds`,
  );
  const fundMap = new Map(funds.map((f) => [f.id, f]));

  // Read latest FIN_STATS upload per fund
  const uploads = await prisma.$queryRawUnsafe<
    Array<{ id: string; fundId: string; filePath: string; fileName: string; reportDate: Date }>
  >(
    `SELECT DISTINCT ON ("fundId") id, "fundId", "filePath", "fileName", "reportDate"
     FROM public.daily_fund_uploads
     WHERE "uploadType" = 'FIN_STATS' AND status = 'PROCESSED'
     ORDER BY "fundId", "reportDate" DESC`,
  );

  // Current open FY for period anchor
  const fy = await prisma.fiscalYear.findFirst({
    where: { isClosed: false },
    orderBy: { startsOn: "desc" },
  });
  if (!fy) {
    redirect("/management-fees?error=No+open+fiscal+year");
  }

  const summary: string[] = [];
  for (const up of uploads) {
    const fund = fundMap.get(up.fundId);
    if (!fund) {
      summary.push(`skipped ${up.fileName}: unknown fund id`);
      continue;
    }
    try {
      const res = await fetch(up.filePath);
      if (!res.ok) {
        summary.push(`failed ${fund.code}: HTTP ${res.status}`);
        continue;
      }
      const buf = await res.arrayBuffer();
      const { total, rowCount } = await parseManagementFeeFromXlsx(buf, fy.startsOn, up.reportDate);

      await withActor(me.id, (tx) =>
        tx.managementFeeImport.upsert({
          where: {
            fundCode_periodStart_periodEnd: {
              fundCode: fund.code,
              periodStart: fy.startsOn,
              periodEnd: up.reportDate,
            },
          },
          create: {
            fundCode: fund.code,
            periodStart: fy.startsOn,
            periodEnd: up.reportDate,
            computedAmount: total,
            sourceUploadId: up.id,
            sourceFileName: up.fileName,
            importedBy: me.id,
            notes: `${rowCount} 'Management Fee' debit row(s) summed from fund FIN_STATS`,
          },
          update: {
            computedAmount: total,
            sourceUploadId: up.id,
            sourceFileName: up.fileName,
            notes: `Re-imported ${new Date().toISOString().slice(0, 10)} — ${rowCount} rows`,
          },
        }),
      );
      summary.push(`${fund.code}: ${rowCount} rows → ${total.toFixed(2)}`);
    } catch (e) {
      summary.push(`failed ${fund.code}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  revalidatePath("/management-fees");
  redirect(`/management-fees?ok=${encodeURIComponent(summary.join(" · "))}`);
}

export async function setManualAmount(formData: FormData): Promise<void> {
  const me = await requireRole(["admin", "accountant"]);
  const id = String(formData.get("id") ?? "").trim();
  const raw = String(formData.get("manualAmount") ?? "").trim();
  if (!id) return;

  const manual = raw === "" ? null : Number(raw);
  if (manual != null && !Number.isFinite(manual)) {
    redirect(`/management-fees?error=${encodeURIComponent("Manual amount must be a number.")}`);
  }

  await withActor(me.id, (tx) =>
    tx.managementFeeImport.update({
      where: { id },
      data: { manualAmount: manual, status: manual == null ? "imported" : "reviewed" },
    }),
  );
  revalidatePath("/management-fees");
}

export async function setStatus(formData: FormData): Promise<void> {
  const me = await requireRole(["admin", "accountant"]);
  const id = String(formData.get("id") ?? "").trim();
  const status = String(formData.get("status") ?? "").trim();
  if (!id || !["imported", "reviewed", "verified"].includes(status)) return;

  await withActor(me.id, (tx) =>
    tx.managementFeeImport.update({
      where: { id },
      data: {
        status: status as "imported" | "reviewed" | "verified",
        verifiedAt: status === "verified" ? new Date() : null,
        verifiedBy: status === "verified" ? me.id : null,
      },
    }),
  );
  revalidatePath("/management-fees");
}
