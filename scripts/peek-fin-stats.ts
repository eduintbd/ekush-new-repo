// Fetch the latest FIN_STATS xlsx for each fund from Vercel Blob and dump
// any sheet rows containing "management fee" so we can see where it lives.

import ExcelJS, { type CellRichTextValue, type CellFormulaValue } from "exceljs";
import { PrismaClient } from "../src/generated/prisma";

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

async function main() {
  const p = new PrismaClient();
  const uploads = await p.$queryRawUnsafe<Array<{ id: string; fundId: string; filePath: string; fileName: string; reportDate: Date }>>(
    `SELECT id, "fundId", "filePath", "fileName", "reportDate"
     FROM public.daily_fund_uploads
     WHERE "uploadType" = 'FIN_STATS' AND status = 'PROCESSED'
     ORDER BY "reportDate" DESC LIMIT 3`,
  );
  const funds = await p.$queryRawUnsafe<Array<{ id: string; code: string; name: string }>>(
    `SELECT id, code, name FROM public.funds`,
  );
  const fundMap = new Map(funds.map((f) => [f.id, f]));

  for (const u of uploads) {
    const fund = fundMap.get(u.fundId);
    console.log(`\n=== ${fund?.code} (${fund?.name}) ===`);
    console.log(`File: ${u.fileName}`);
    console.log(`URL : ${u.filePath}`);

    const res = await fetch(u.filePath);
    if (!res.ok) {
      console.log(`  FETCH FAILED: ${res.status}`);
      continue;
    }
    const buf = await res.arrayBuffer();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);

    console.log("Sheets:");
    wb.eachSheet((s) => console.log(`  - ${s.name} (${s.rowCount} rows)`));

    // Find rows mentioning "management fee" across all sheets
    console.log("\nRows mentioning 'management fee' or 'mgmt fee':");
    wb.eachSheet((sheet) => {
      for (let r = 1; r <= sheet.rowCount; r++) {
        const row = sheet.getRow(r);
        const cells: string[] = [];
        for (let c = 1; c <= Math.min(sheet.columnCount, 15); c++) {
          cells.push(cellText(row.getCell(c).value));
        }
        const joined = cells.join(" | ").toLowerCase();
        if (joined.includes("management fee") || joined.includes("mgmt fee") || joined.includes("mfm fee")) {
          console.log(`  [${sheet.name}] r${r}: ${cells.filter(Boolean).join(" | ")}`);
        }
      }
    });
  }

  await p.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
