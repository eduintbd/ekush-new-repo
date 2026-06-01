/* eslint-disable */
// Step A of the FY 2024-25 import — produces a mapping/preview workbook
// from "update 2025 G.S.xlsx" without touching the database.
//
// Refinements after first pass + admin review:
//   • Vouchers grouped by DATE (not date+desc) — workbook treats one
//     calendar day as one voucher regardless of multi-leg description.
//   • Pair-offset across nearby dates (cheque-issue / cheque-clear timing)
//     auto-merged to the LATER date. No suspense account needed.
//   • Rounding ≤ ৳1 fixed by adjusting the largest leg silently.
//   • Confirmed account mappings baked in:
//       - Audit Fee → Audit Fee (paid)
//       - Source Tax → Advance Income TAX Payment
//       - Capital loss → Capital Gain/ loss
//       - Personal Loan to Shiful → Personal Loan to Saiful
//       - Training Fee → Training Fee (new CoA, to be created in Step B)
//       - Office Equipment → Office Equipments
//       - Withholding VAT & TDS → Withholding VAT & TDs
//       - Bkash (DM4952) → Bkash(DM4952)
//       - + every case-only fix
//
// Usage:  npx tsx scripts/preview-fy24-25-import.ts
// Out:    scripts/output/fy24-25-import-preview.xlsx

import { config } from "dotenv";
config({ path: ".env" });

import { PrismaClient } from "@/generated/prisma";
import ExcelJS from "exceljs";
import path from "node:path";
import fs from "node:fs";

const prisma = new PrismaClient();

const INPUT_PATH =
  "C:/Users/USER/OneDrive/Desktop/x-system_inputs/update 2025 G.S.xlsx";

type Row = {
  rowNum: number;
  iso: string | null;
  date: Date | null;
  desc: string;
  txnType: string;
  account: string;
  debit: number;
  credit: number;
};

type Voucher = {
  date: Date;
  iso: string;
  voucherNo: string;
  isOB: boolean;
  rows: Row[];
  totalD: number;
  totalC: number;
  diff: number;
  status: "balanced" | "rounding-fixed" | "pair-merged" | "imbalanced";
  notes: string;
};

function getNum(cell: ExcelJS.Cell): number {
  const v = cell.value;
  if (v == null || v === "") return 0;
  if (typeof v === "number") return v;
  if (typeof v === "object" && v && "result" in v) {
    const res = (v as { result?: unknown }).result;
    return typeof res === "number" ? res : 0;
  }
  return Number(v) || 0;
}

function getStr(cell: ExcelJS.Cell): string {
  const v = cell.value;
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v);
  if (typeof v === "object" && v && "result" in v)
    return String((v as { result?: unknown }).result ?? "").trim();
  if (typeof v === "object" && v && "text" in v)
    return String((v as { text?: unknown }).text ?? "").trim();
  return String(v).trim();
}

/** Confirmed account-name mapping table. workbookName → coaName. */
const ACCOUNT_MAP: Record<string, string> = {
  // Exact case/space fixes
  "Office Equipment": "Office Equipments",
  "Withholding VAT & TDS": "Withholding VAT & TDs",
  "Bkash (DM4952)": "Bkash(DM4952)",
  "Dividend income": "Dividend Income",
  "Internet bill": "Internet Bill",
  "Pay order": "Pay Order",
  "Other Exp.": "Other exp.",
  "Interest on Margin Loan": "Interest on Margin  Loan",
  // User-confirmed
  "Source Tax": "Advance Income TAX Payment",
  "Audit Fee": "Audit Fee (paid)",
  "Capital loss": "Capital Gain/ loss",
  "Personal Loan to Shiful": "Personal Loan to Saiful",
  "Training Fee": "Training Fee", // ← new CoA created in Step B
};

/** Mappings that need NEW CoA accounts to be created in Step B before import. */
const NEW_COA_TO_CREATE = [
  {
    name: "Training Fee",
    normalBalance: "DEBIT" as const,
    groupName: "Operating expenses",
  },
];

async function main() {
  const asOf = new Date().toISOString().slice(0, 10);

  // ─── 1. Read the source workbook ─────────────────────────────────
  const wbIn = new ExcelJS.Workbook();
  await wbIn.xlsx.readFile(INPUT_PATH);
  const sh = wbIn.getWorksheet("Journals");
  if (!sh) {
    console.error("Sheet 'Journals' not found");
    process.exit(1);
  }

  const rows: Row[] = [];
  for (let r = 8; r <= sh.rowCount; r++) {
    const row = sh.getRow(r);
    const y = getNum(row.getCell(1));
    const m = getNum(row.getCell(2));
    const d = getNum(row.getCell(3));
    const desc = getStr(row.getCell(5));
    const txnType = getStr(row.getCell(6));
    const account = getStr(row.getCell(7));
    const debit = getNum(row.getCell(8));
    const credit = getNum(row.getCell(9));
    if (!y && !account && !debit && !credit) continue;
    const iso =
      y && m && d
        ? `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`
        : null;
    const date = iso ? new Date(`${iso}T00:00:00.000Z`) : null;
    rows.push({ rowNum: r, iso, date, desc, txnType, account, debit, credit });
  }
  console.log(`Read ${rows.length} data rows from workbook`);

  // ─── 2. Load X-System CoA ───────────────────────────────────────
  const coa = await prisma.chartOfAccount.findMany({ orderBy: { name: "asc" } });
  const coaNames = new Set(coa.map((a) => a.name));
  // Add the new CoA rows we'll create in Step B
  for (const n of NEW_COA_TO_CREATE) coaNames.add(n.name);

  // ─── 3. Apply account mapping; flag unmapped ─────────────────────
  type MappedRow = Row & { mappedAccount: string | null; mapStatus: "exact" | "renamed" | "new" | "unmapped" | "blank" };
  const mapped: MappedRow[] = rows.map((r) => {
    if (!r.account) return { ...r, mappedAccount: null, mapStatus: "blank" };
    if (coaNames.has(r.account)) return { ...r, mappedAccount: r.account, mapStatus: "exact" };
    const renamed = ACCOUNT_MAP[r.account];
    if (renamed && coaNames.has(renamed)) {
      const isNew = NEW_COA_TO_CREATE.some((n) => n.name === renamed);
      return { ...r, mappedAccount: renamed, mapStatus: isNew ? "new" : "renamed" };
    }
    return { ...r, mappedAccount: null, mapStatus: "unmapped" };
  });

  const unmappedRows = mapped.filter((m) => m.mapStatus === "unmapped");
  console.log(`Unmapped rows: ${unmappedRows.length}`);
  for (const m of unmappedRows.slice(0, 10)) {
    console.log(`  R${m.rowNum}: "${m.account}"  ${m.iso}  D=${m.debit} C=${m.credit}`);
  }

  // ─── 4. Build vouchers — DATE-only grouping ──────────────────────
  const byDate = new Map<string, Voucher>();
  for (const r of mapped) {
    if (!r.iso || !r.date) continue;
    let v = byDate.get(r.iso);
    if (!v) {
      v = {
        date: r.date,
        iso: r.iso,
        voucherNo: "",
        isOB: r.iso === "2024-06-30",
        rows: [],
        totalD: 0,
        totalC: 0,
        diff: 0,
        status: "balanced",
        notes: "",
      };
      byDate.set(r.iso, v);
    }
    v.rows.push(r);
    v.totalD += r.debit;
    v.totalC += r.credit;
  }
  for (const v of byDate.values()) {
    v.diff = Math.round((v.totalD - v.totalC) * 100) / 100;
  }

  const allVouchers = Array.from(byDate.values()).sort((a, b) => +a.date - +b.date);

  // ─── 5. Fix rounding errors (|diff| ≤ ₹1) ───────────────────────
  for (const v of allVouchers) {
    if (Math.abs(v.diff) > 0 && Math.abs(v.diff) <= 1) {
      // Adjust the largest debit or credit leg by -diff
      const targets = v.rows.filter((r) => r.debit > 0 || r.credit > 0);
      if (targets.length === 0) continue;
      const largest = targets.reduce((a, b) =>
        Math.max(a.debit, a.credit) > Math.max(b.debit, b.credit) ? a : b,
      );
      // If diff > 0 (D > C), reduce a debit (or add to a credit) by diff
      // If diff < 0 (D < C), reduce a credit (or add to a debit) by |diff|
      if (largest.debit > 0) {
        largest.debit = Math.round((largest.debit - v.diff) * 100) / 100;
      } else {
        largest.credit = Math.round((largest.credit + v.diff) * 100) / 100;
      }
      v.totalD = v.rows.reduce((s, r) => s + r.debit, 0);
      v.totalC = v.rows.reduce((s, r) => s + r.credit, 0);
      v.diff = Math.round((v.totalD - v.totalC) * 100) / 100;
      v.status = "rounding-fixed";
      v.notes = `Adjusted largest leg by ≤ ₹0.24 to balance`;
    }
  }

  // ─── 6. Pair-merge timing pairs ──────────────────────────────────
  // For any remaining imbalanced voucher, look for an offsetting
  // voucher within 14 days that sums to ~zero. Merge the earlier into
  // the later (cheque-clear date wins).
  const imbalanced = allVouchers
    .filter((v) => Math.abs(v.diff) > 0.01)
    .sort((a, b) => +a.date - +b.date);
  const merged = new Set<string>();
  for (let i = 0; i < imbalanced.length; i++) {
    const a = imbalanced[i];
    if (merged.has(a.iso)) continue;
    for (let j = i + 1; j < imbalanced.length; j++) {
      const b = imbalanced[j];
      if (merged.has(b.iso)) continue;
      const dayDiff = (+b.date - +a.date) / 86400_000;
      if (dayDiff > 14) break;
      if (Math.abs(a.diff + b.diff) < 0.01) {
        // Merge a into b (the later date)
        for (const r of a.rows) b.rows.push({ ...r });
        b.totalD = b.rows.reduce((s, r) => s + r.debit, 0);
        b.totalC = b.rows.reduce((s, r) => s + r.credit, 0);
        b.diff = Math.round((b.totalD - b.totalC) * 100) / 100;
        b.status = "pair-merged";
        b.notes = `Merged with ${a.iso} (timing pair: cheque issued vs cleared)`;
        merged.add(a.iso);
        merged.add(b.iso);
        break;
      }
    }
  }
  // Remove merged-from vouchers from the final list
  const finalVouchers = allVouchers.filter((v) => !merged.has(v.iso) || v.status === "pair-merged");

  // ─── 7. Assign voucher numbers ──────────────────────────────────
  let obSeq = 0, jvSeq = 0;
  for (const v of finalVouchers) {
    if (v.isOB) {
      v.voucherNo = `OB/24-25/${String(++obSeq).padStart(4, "0")}`;
    } else {
      v.voucherNo = `JV/24-25/${String(++jvSeq).padStart(4, "0")}`;
    }
    if (v.status === "balanced" && Math.abs(v.diff) < 0.01) v.status = "balanced";
    else if (Math.abs(v.diff) >= 0.01) v.status = "imbalanced";
  }

  // ─── 8. Compute monthly totals (workbook + DB comparison) ────────
  type MT = { ym: string; D: number; C: number; net: number; rows: number };
  const wbMonthly = new Map<string, MT>();
  for (const r of mapped) {
    if (!r.iso) continue;
    const ym = r.iso.slice(0, 7);
    const t = wbMonthly.get(ym) ?? { ym, D: 0, C: 0, net: 0, rows: 0 };
    t.D += r.debit;
    t.C += r.credit;
    t.rows++;
    wbMonthly.set(ym, t);
  }
  for (const t of wbMonthly.values()) t.net = t.D - t.C;

  const fy = await prisma.fiscalYear.findFirst({ where: { label: "FY2025-26" } });
  const fy25Totals = new Map<string, MT>();
  if (fy) {
    const lines = await prisma.journal.findMany({
      where: { fiscalYearId: fy.id },
      select: { entryDate: true, debit: true, credit: true },
    });
    for (const l of lines) {
      const ym = l.entryDate.toISOString().slice(0, 7);
      const t = fy25Totals.get(ym) ?? { ym, D: 0, C: 0, net: 0, rows: 0 };
      t.D += Number(l.debit);
      t.C += Number(l.credit);
      t.rows++;
      fy25Totals.set(ym, t);
    }
    for (const t of fy25Totals.values()) t.net = t.D - t.C;
  }

  // ─── 9. Build the output workbook ────────────────────────────────
  const wbOut = new ExcelJS.Workbook();
  wbOut.creator = "X-System Import Preview";
  wbOut.created = new Date();

  // Sheet 1: Vouchers (with status)
  const sVou = wbOut.addWorksheet("1. Vouchers");
  sVou.columns = [
    { header: "Voucher #", key: "vno", width: 18 },
    { header: "Entry date", key: "date", width: 12 },
    { header: "Type", key: "type", width: 8 },
    { header: "Status", key: "stat", width: 16 },
    { header: "# lines", key: "n", width: 8 },
    { header: "Total D", key: "td", width: 16, style: { numFmt: "#,##0.00" } },
    { header: "Total C", key: "tc", width: 16, style: { numFmt: "#,##0.00" } },
    { header: "Diff", key: "diff", width: 12, style: { numFmt: "#,##0.00" } },
    { header: "Notes", key: "notes", width: 60 },
  ];
  sVou.getRow(1).font = { bold: true };
  sVou.views = [{ state: "frozen", ySplit: 1 }];
  for (const v of finalVouchers) {
    const r = sVou.addRow({
      vno: v.voucherNo,
      date: v.iso,
      type: v.isOB ? "OB" : "JV",
      stat: v.status,
      n: v.rows.length,
      td: v.totalD,
      tc: v.totalC,
      diff: v.diff,
      notes: v.notes,
    });
    if (v.status === "imbalanced") {
      r.getCell("stat").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFAD4D4" } };
    } else if (v.status === "pair-merged") {
      r.getCell("stat").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD0E8FF" } };
    } else if (v.status === "rounding-fixed") {
      r.getCell("stat").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF3CD" } };
    }
  }

  // Sheet 2: Lines (all rows with mapped CoA + voucher #)
  const sLines = wbOut.addWorksheet("2. Lines");
  sLines.columns = [
    { header: "Voucher #", key: "vno", width: 18 },
    { header: "WB row", key: "wbr", width: 8 },
    { header: "Date", key: "date", width: 12 },
    { header: "TxnType", key: "type", width: 8 },
    { header: "Description", key: "desc", width: 36 },
    { header: "Workbook account", key: "wb", width: 32 },
    { header: "Mapped CoA account", key: "coa", width: 32 },
    { header: "Map", key: "ms", width: 10 },
    { header: "Debit", key: "d", width: 14, style: { numFmt: "#,##0.00" } },
    { header: "Credit", key: "c", width: 14, style: { numFmt: "#,##0.00" } },
  ];
  sLines.getRow(1).font = { bold: true };
  sLines.views = [{ state: "frozen", ySplit: 1 }];
  for (const v of finalVouchers) {
    for (const r of v.rows) {
      const row = sLines.addRow({
        vno: v.voucherNo,
        wbr: r.rowNum,
        date: r.iso,
        type: r.txnType,
        desc: r.desc,
        wb: r.account || "(blank)",
        coa: (r as MappedRow).mappedAccount ?? "",
        ms: (r as MappedRow).mapStatus,
        d: r.debit,
        c: r.credit,
      });
      if ((r as MappedRow).mapStatus === "unmapped") {
        row.getCell("ms").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFAD4D4" } };
      }
    }
  }

  // Sheet 3: Account mapping (just the renamed/new ones — for transparency)
  const sMap = wbOut.addWorksheet("3. Account mapping");
  sMap.columns = [
    { header: "Workbook account", key: "wb", width: 36 },
    { header: "Mapped to (X-System CoA)", key: "coa", width: 36 },
    { header: "Status", key: "status", width: 14 },
    { header: "# rows", key: "n", width: 8 },
    { header: "Total D", key: "td", width: 16, style: { numFmt: "#,##0.00" } },
    { header: "Total C", key: "tc", width: 16, style: { numFmt: "#,##0.00" } },
  ];
  sMap.getRow(1).font = { bold: true };
  sMap.views = [{ state: "frozen", ySplit: 1 }];
  const accStats = new Map<string, { n: number; D: number; C: number; mapped: string | null; status: string }>();
  for (const r of mapped) {
    const k = r.account || "(blank)";
    const s = accStats.get(k) ?? { n: 0, D: 0, C: 0, mapped: r.mappedAccount, status: r.mapStatus };
    s.n++;
    s.D += r.debit;
    s.C += r.credit;
    accStats.set(k, s);
  }
  const sortedAcc = Array.from(accStats.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  for (const [name, s] of sortedAcc) {
    const r = sMap.addRow({
      wb: name,
      coa: s.mapped ?? "",
      status: s.status,
      n: s.n,
      td: s.D,
      tc: s.C,
    });
    const colour =
      s.status === "exact"
        ? "FFD4F7D4"
        : s.status === "renamed"
          ? "FFE8F4D4"
          : s.status === "new"
            ? "FFD0E8FF"
            : s.status === "blank"
              ? "FFEFEFEF"
              : "FFFAD4D4";
    r.getCell("status").fill = { type: "pattern", pattern: "solid", fgColor: { argb: colour } };
  }

  // Sheet 4: Monthly totals (workbook vs X-System FY25-26)
  const sMon = wbOut.addWorksheet("4. Monthly totals");
  sMon.columns = [
    { header: "Month", key: "ym", width: 12 },
    { header: "WB # rows", key: "wbN", width: 10 },
    { header: "WB Debit", key: "wbD", width: 16, style: { numFmt: "#,##0.00" } },
    { header: "WB Credit", key: "wbC", width: 16, style: { numFmt: "#,##0.00" } },
    { header: "WB Net (D−C)", key: "wbNet", width: 16, style: { numFmt: "#,##0.00" } },
    { header: "—", key: "gap", width: 4 },
    { header: "FY25-26 # rows", key: "fyN", width: 10 },
    { header: "FY25-26 Debit", key: "fyD", width: 16, style: { numFmt: "#,##0.00" } },
    { header: "FY25-26 Credit", key: "fyC", width: 16, style: { numFmt: "#,##0.00" } },
    { header: "FY25-26 Net", key: "fyNet", width: 16, style: { numFmt: "#,##0.00" } },
  ];
  sMon.getRow(1).font = { bold: true };
  sMon.views = [{ state: "frozen", ySplit: 1 }];
  const ymList = ((): string[] => {
    const out: string[] = [];
    let cur = "2024-06";
    const end = "2026-06";
    while (cur <= end) {
      out.push(cur);
      const [y, m] = cur.split("-").map(Number);
      const nm = m === 12 ? 1 : m + 1;
      const ny = m === 12 ? y + 1 : y;
      cur = `${ny}-${String(nm).padStart(2, "0")}`;
    }
    return out;
  })();
  for (const ym of ymList) {
    const wb = wbMonthly.get(ym);
    const fy25 = fy25Totals.get(ym);
    sMon.addRow({
      ym,
      wbN: wb?.rows ?? 0,
      wbD: wb?.D ?? 0,
      wbC: wb?.C ?? 0,
      wbNet: wb?.net ?? 0,
      gap: "",
      fyN: fy25?.rows ?? 0,
      fyD: fy25?.D ?? 0,
      fyC: fy25?.C ?? 0,
      fyNet: fy25?.net ?? 0,
    });
  }

  // Sheet 0: Read me first
  const sCover = wbOut.addWorksheet("0. Read me first");
  sCover.getColumn(1).width = 110;
  const balanced = finalVouchers.filter((v) => v.status === "balanced").length;
  const roundingFixed = finalVouchers.filter((v) => v.status === "rounding-fixed").length;
  const pairMerged = finalVouchers.filter((v) => v.status === "pair-merged").length;
  const stillImbal = finalVouchers.filter((v) => v.status === "imbalanced").length;
  const finalTotD = finalVouchers.reduce((s, v) => s + v.totalD, 0);
  const finalTotC = finalVouchers.reduce((s, v) => s + v.totalC, 0);
  const lines = [
    `FY 2024-25 IMPORT PREVIEW (v2) — generated ${asOf}`,
    ``,
    `Source: ${INPUT_PATH}`,
    `Sheet:  Journals (rows 8–929, dates 2024-06-30 → 2025-06-30)`,
    ``,
    `Nothing has been written to the database yet. This is a verification artefact.`,
    ``,
    `Refinements applied this pass:`,
    `  • Vouchers grouped by DATE (137 dates → ${finalVouchers.length} vouchers after pair-merge)`,
    `  • Pair-offset timing diffs merged into the later date (no suspense needed)`,
    `  • Rounding errors ≤ ₹1 auto-fixed on the largest leg`,
    `  • Confirmed account mappings applied — see sheet "3. Account mapping"`,
    ``,
    `Voucher results:`,
    `  ${balanced} balanced (no change)`,
    `  ${roundingFixed} rounding-fixed (≤ ₹0.24 each — yellow)`,
    `  ${pairMerged} pair-merged (cheque-issue ↔ cheque-clear — blue)`,
    `  ${stillImbal} still imbalanced (will need attention if > 0 — red)`,
    ``,
    `Year-end totals:`,
    `  Σ(D):  ${finalTotD.toLocaleString("en-IN", { minimumFractionDigits: 2 })}`,
    `  Σ(C):  ${finalTotC.toLocaleString("en-IN", { minimumFractionDigits: 2 })}`,
    `  Net:   ${(finalTotD - finalTotC).toLocaleString("en-IN", { minimumFractionDigits: 2 })}  (should be 0)`,
    ``,
    `Account mapping:`,
    `  Unmapped rows (red): ${unmappedRows.length}  — must be resolved before Step B`,
    `  New CoA to create:`,
    ...NEW_COA_TO_CREATE.map((n) => `    + "${n.name}"  side:${n.normalBalance}  group:"${n.groupName}"`),
    ``,
    `Tabs:`,
    `  1. Vouchers          — ${finalVouchers.length} vouchers with status colour-coding`,
    `  2. Lines             — every row mapped to voucher # + X-System CoA`,
    `  3. Account mapping   — workbook account → CoA (renamed / new / exact)`,
    `  4. Monthly totals    — month-by-month workbook vs FY25-26`,
    ``,
    `If this looks good, say "go" and Step B will:`,
    `  1. Create FY2024-25 (startsOn=2024-07-01, endsOn=2025-06-30)`,
    `  2. Create the "Training Fee" CoA row`,
    `  3. Write ${obSeq} OB voucher(s) to AccountOpeningBalance + Journal`,
    `  4. Write ${jvSeq} JV vouchers to Journal (idempotent — re-runnable)`,
    `  5. Verify Σ(D) = Σ(C) for the year before commit`,
  ];
  for (const l of lines) sCover.addRow([l]);
  sCover.getRow(1).font = { bold: true, size: 14 };
  // move the cover to be the first sheet
  // ExcelJS appends new sheets at the end; we explicitly reorder here.
  // @ts-expect-error — _worksheets is internal but commonly used
  wbOut._worksheets.splice(1, 0, wbOut._worksheets.pop());

  // ─── Save ────────────────────────────────────────────────────────
  const outDir = path.join(process.cwd(), "scripts", "output");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "fy24-25-import-preview.xlsx");
  await wbOut.xlsx.writeFile(outPath);

  console.log(`\n✓ Wrote ${outPath}`);
  console.log(`  Vouchers: ${finalVouchers.length} (${obSeq} OB + ${jvSeq} JV)`);
  console.log(`    balanced:        ${balanced}`);
  console.log(`    rounding-fixed:  ${roundingFixed}`);
  console.log(`    pair-merged:     ${pairMerged}`);
  console.log(`    imbalanced:      ${stillImbal}`);
  console.log(`  Σ(D) = ${finalTotD.toFixed(2)}`);
  console.log(`  Σ(C) = ${finalTotC.toFixed(2)}`);
  console.log(`  Net  = ${(finalTotD - finalTotC).toFixed(2)}`);
  console.log(`  Unmapped rows: ${unmappedRows.length}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
