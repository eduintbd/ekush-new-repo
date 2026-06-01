/* eslint-disable */
// Step B of the FY 2024-25 import — actually writes to the database.
// Consumes the same workbook + applies the same transforms as
// scripts/preview-fy24-25-import.ts, then persists:
//
//   1. FY2024-25 row (startsOn=2024-07-01, endsOn=2025-06-30)
//   2. New "Training Fee" CoA row (debit-normal, Operating expenses)
//   3. 1 OB voucher (31 lines) → AccountOpeningBalance + Journal rows
//   4. 133 JV vouchers (~889 lines) → Journal rows
//
// Idempotency:
//   - FY2024-25 is upserted by label.
//   - Training Fee CoA: skipped if already exists.
//   - AccountOpeningBalance: upserted by (fiscalYearId, accountName).
//   - Journal rows: deleted-then-recreated for any voucherNo starting
//     with "OB/24-25/" or "JV/24-25/" so re-running the script gives a
//     clean state. Safe because no downstream system references these
//     voucherNos yet (FY2024-25 has never been imported before).
//
// Pre-flight + post-flight checks:
//   • Σ(D) = Σ(C) for the year (will abort + roll back if off by > ₹0.01)
//   • Every accountName referenced exists in ChartOfAccount
//
// Usage:  npx tsx scripts/import-fy24-25.ts
// Or:     npx tsx scripts/import-fy24-25.ts --dry-run    (does everything
//                                                          in a tx then rolls back)

import { config } from "dotenv";
config({ path: ".env" });

import { PrismaClient, Prisma } from "@/generated/prisma";
import ExcelJS from "exceljs";
import { randomUUID } from "node:crypto";

const prisma = new PrismaClient();

const INPUT_PATH =
  "C:/Users/USER/OneDrive/Desktop/x-system_inputs/update 2025 G.S.xlsx";

const ACCOUNT_MAP: Record<string, string> = {
  "Office Equipment": "Office Equipments",
  "Withholding VAT & TDS": "Withholding VAT & TDs",
  "Bkash (DM4952)": "Bkash(DM4952)",
  "Dividend income": "Dividend Income",
  "Internet bill": "Internet Bill",
  "Pay order": "Pay Order",
  "Other Exp.": "Other exp.",
  "Interest on Margin Loan": "Interest on Margin  Loan",
  "Source Tax": "Advance Income TAX Payment",
  "Audit Fee": "Audit Fee (paid)",
  "Capital loss": "Capital Gain/ loss",
  "Personal Loan to Shiful": "Personal Loan to Saiful",
  "Training Fee": "Training Fee", // ← created by this script
};

type Row = {
  rowNum: number;
  iso: string;
  date: Date;
  desc: string;
  txnType: string;
  account: string; // mapped
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

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Read & map workbook → Voucher[] (same logic as the preview script). */
async function buildVouchers(coaNames: Set<string>): Promise<Voucher[]> {
  const wbIn = new ExcelJS.Workbook();
  await wbIn.xlsx.readFile(INPUT_PATH);
  const sh = wbIn.getWorksheet("Journals");
  if (!sh) throw new Error("Journals sheet not found");

  const rawRows: Row[] = [];
  for (let r = 8; r <= sh.rowCount; r++) {
    const row = sh.getRow(r);
    const y = getNum(row.getCell(1));
    const m = getNum(row.getCell(2));
    const d = getNum(row.getCell(3));
    const desc = getStr(row.getCell(5));
    const txnType = getStr(row.getCell(6));
    const rawAccount = getStr(row.getCell(7));
    const debit = getNum(row.getCell(8));
    const credit = getNum(row.getCell(9));
    if (!y && !rawAccount && !debit && !credit) continue;
    if (!y || !m || !d) continue;
    if (!rawAccount && debit === 0 && credit === 0) continue;
    // Skip rows with empty account — there's only one such row in the
    // dataset (R924, all-zero) and including it would break the FK.
    if (!rawAccount) continue;
    const account = coaNames.has(rawAccount) ? rawAccount : ACCOUNT_MAP[rawAccount];
    if (!account || !coaNames.has(account)) {
      throw new Error(
        `Row R${r}: account "${rawAccount}" maps to "${account ?? "(none)"}" which doesn't exist in ChartOfAccount`,
      );
    }
    rawRows.push({
      rowNum: r,
      iso: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
      date: new Date(`${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}T00:00:00.000Z`),
      desc,
      txnType,
      account,
      debit,
      credit,
    });
  }

  // Group by date
  const byDate = new Map<string, Voucher>();
  for (const r of rawRows) {
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
      };
      byDate.set(r.iso, v);
    }
    v.rows.push(r);
    v.totalD += r.debit;
    v.totalC += r.credit;
  }

  const all = Array.from(byDate.values()).sort((a, b) => +a.date - +b.date);

  // Step 1: Rounding-fix (|diff| ≤ ₹1) — adjust largest leg.
  for (const v of all) {
    const diff = r2(v.totalD - v.totalC);
    if (Math.abs(diff) === 0 || Math.abs(diff) > 1) continue;
    const targets = v.rows.filter((r) => r.debit > 0 || r.credit > 0);
    if (targets.length === 0) continue;
    const largest = targets.reduce((a, b) =>
      Math.max(a.debit, a.credit) > Math.max(b.debit, b.credit) ? a : b,
    );
    if (largest.debit > 0) largest.debit = r2(largest.debit - diff);
    else largest.credit = r2(largest.credit + diff);
    v.totalD = v.rows.reduce((s, r) => s + r.debit, 0);
    v.totalC = v.rows.reduce((s, r) => s + r.credit, 0);
  }

  // Step 2: Pair-merge — for each imbalanced voucher, look for an
  // offsetting voucher within 14 days. Merge the EARLIER into the LATER
  // (cheque-clear date wins). Remove the earlier voucher from output.
  const removedIso = new Set<string>();
  const imb = all
    .filter((v) => Math.abs(r2(v.totalD - v.totalC)) > 0.01)
    .sort((a, b) => +a.date - +b.date);
  for (let i = 0; i < imb.length; i++) {
    const a = imb[i];
    if (removedIso.has(a.iso)) continue;
    const diffA = r2(a.totalD - a.totalC);
    for (let j = i + 1; j < imb.length; j++) {
      const b = imb[j];
      if (removedIso.has(b.iso)) continue;
      const dayDiff = (+b.date - +a.date) / 86400_000;
      if (dayDiff > 14) break;
      const diffB = r2(b.totalD - b.totalC);
      if (Math.abs(diffA + diffB) < 0.01) {
        for (const r of a.rows) b.rows.push(r);
        b.totalD = b.rows.reduce((s, r) => s + r.debit, 0);
        b.totalC = b.rows.reduce((s, r) => s + r.credit, 0);
        removedIso.add(a.iso);
        break;
      }
    }
  }

  const cleanVouchers = all
    .filter((v) => !removedIso.has(v.iso))
    .sort((a, b) => +a.date - +b.date);

  // Assign voucher numbers
  let obSeq = 0,
    jvSeq = 0;
  for (const v of cleanVouchers) {
    if (v.isOB) v.voucherNo = `OB/24-25/${String(++obSeq).padStart(4, "0")}`;
    else v.voucherNo = `JV/24-25/${String(++jvSeq).padStart(4, "0")}`;
  }

  return cleanVouchers;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  console.log(`Mode: ${dryRun ? "DRY-RUN (will roll back)" : "COMMIT"}`);

  // ─── 1. Load CoA, including the new one we'll create ─────────────
  const existingCoa = await prisma.chartOfAccount.findMany({ orderBy: { name: "asc" } });
  const coaNames = new Set(existingCoa.map((a) => a.name));
  console.log(`Existing CoA: ${coaNames.size} accounts`);

  // We'll create Training Fee in the transaction below. Pre-add it to
  // the name set so the workbook parser can resolve it.
  const trainingFeeNeeded = !coaNames.has("Training Fee");
  if (trainingFeeNeeded) coaNames.add("Training Fee");

  // ─── 2. Build voucher set ────────────────────────────────────────
  const vouchers = await buildVouchers(coaNames);
  const totalD = vouchers.reduce((s, v) => s + v.totalD, 0);
  const totalC = vouchers.reduce((s, v) => s + v.totalC, 0);
  const totalLines = vouchers.reduce((s, v) => s + v.rows.length, 0);
  console.log(`\nVouchers built: ${vouchers.length}  (lines: ${totalLines})`);
  console.log(`  Σ(D) = ${totalD.toFixed(2)}`);
  console.log(`  Σ(C) = ${totalC.toFixed(2)}`);
  console.log(`  Diff = ${(totalD - totalC).toFixed(2)}`);
  if (Math.abs(totalD - totalC) > 0.01) {
    console.error(`ABORT: year totals don't balance.`);
    process.exit(1);
  }

  // Per-voucher balance check
  const stillImbalanced = vouchers.filter((v) => Math.abs(r2(v.totalD - v.totalC)) > 0.01);
  if (stillImbalanced.length > 0) {
    console.error(`ABORT: ${stillImbalanced.length} voucher(s) still imbalanced after merge:`);
    for (const v of stillImbalanced) {
      console.error(`  ${v.voucherNo} ${v.iso} D=${v.totalD.toFixed(2)} C=${v.totalC.toFixed(2)}`);
    }
    process.exit(1);
  }

  // ─── 3. Find admin profile for createdBy ─────────────────────────
  const admin = await prisma.profile.findFirst({
    where: { role: "admin", isActive: true },
    orderBy: { createdAt: "asc" },
  });
  if (!admin) {
    console.error("ABORT: no active admin profile found for createdBy");
    process.exit(1);
  }
  console.log(`createdBy: ${admin.email} (${admin.id})`);

  // ─── 4. The actual write — in one transaction ────────────────────
  const obVoucher = vouchers.find((v) => v.isOB);
  const jvVouchers = vouchers.filter((v) => !v.isOB);

  await prisma.$transaction(
    async (tx) => {
      // Set the audit-trail GUC for triggers
      await tx.$executeRawUnsafe(`SET LOCAL xsystem.actor_uuid = '${admin.id}'`);

      // 4a. Upsert FY2024-25
      const fy = await tx.fiscalYear.upsert({
        where: { label: "FY2024-25" },
        create: {
          label: "FY2024-25",
          startsOn: new Date("2024-07-01T00:00:00.000Z"),
          endsOn: new Date("2025-06-30T00:00:00.000Z"),
          isClosed: false,
        },
        update: {},
      });
      console.log(`\n✓ FiscalYear ${fy.label} (${fy.id})`);

      // 4b. Create Training Fee CoA (if missing)
      if (trainingFeeNeeded) {
        const opExp = await tx.accountGroup.findFirst({
          where: { name: "Operating expenses" },
        });
        if (!opExp) throw new Error("Operating expenses group not found");
        const maxSl = await tx.chartOfAccount.aggregate({ _max: { sl: true } });
        await tx.chartOfAccount.create({
          data: {
            sl: (maxSl._max.sl ?? 0) + 1,
            name: "Training Fee",
            normalBalance: "DEBIT",
            groupId: opExp.id,
          },
        });
        console.log(`✓ Created CoA "Training Fee" (DEBIT, group: Operating expenses)`);
      } else {
        console.log(`• CoA "Training Fee" already exists — skipped`);
      }

      // 4c. Wipe any existing FY24-25 vouchers + OBs (idempotency)
      const delJ = await tx.journal.deleteMany({
        where: {
          OR: [
            { voucherNo: { startsWith: "OB/24-25/" } },
            { voucherNo: { startsWith: "JV/24-25/" } },
          ],
        },
      });
      const delOB = await tx.accountOpeningBalance.deleteMany({
        where: { fiscalYearId: fy.id },
      });
      console.log(
        `• Cleanup: deleted ${delJ.count} prior Journal rows + ${delOB.count} OB rows for FY24-25`,
      );

      // 4d. Insert OB voucher → AccountOpeningBalance + Journal
      if (obVoucher) {
        const batchId = randomUUID();
        // AccountOpeningBalance — one row per (FY, account). Combine
        // multiple lines on the same account (none in this dataset, but
        // be defensive).
        const obByAccount = new Map<string, { D: number; C: number }>();
        for (const r of obVoucher.rows) {
          const k = r.account;
          const t = obByAccount.get(k) ?? { D: 0, C: 0 };
          t.D += r.debit;
          t.C += r.credit;
          obByAccount.set(k, t);
        }
        for (const [acc, t] of obByAccount) {
          await tx.accountOpeningBalance.create({
            data: {
              fiscalYearId: fy.id,
              accountName: acc,
              openingDebit: t.D,
              openingCredit: t.C,
            },
          });
        }
        // Mirror as Journal rows for the OB voucher
        for (const r of obVoucher.rows) {
          await tx.journal.create({
            data: {
              entryDate: r.date,
              description: r.desc || "Opening balance — FY 2024-25",
              txnType: "OB",
              voucherNo: obVoucher.voucherNo,
              accountName: r.account,
              debit: r.debit,
              credit: r.credit,
              fiscalYearId: fy.id,
              batchId,
              createdBy: admin.id,
            },
          });
        }
        console.log(
          `✓ Inserted OB voucher ${obVoucher.voucherNo}: ${obVoucher.rows.length} lines, ${obByAccount.size} account-OBs`,
        );
      }

      // 4e. Insert JV vouchers — one batchId per voucher
      let jvInserted = 0;
      let lineInserted = 0;
      for (const v of jvVouchers) {
        const batchId = randomUUID();
        const lines = v.rows.map((r) =>
          tx.journal.create({
            data: {
              entryDate: r.date,
              description: r.desc || null,
              txnType: r.txnType || null,
              voucherNo: v.voucherNo,
              accountName: r.account,
              debit: r.debit,
              credit: r.credit,
              fiscalYearId: fy.id,
              batchId,
              createdBy: admin.id,
            },
          }),
        );
        // Sequentialise to keep the transaction reasonable
        for (const p of lines) await p;
        lineInserted += v.rows.length;
        jvInserted++;
        if (jvInserted % 25 === 0) console.log(`  inserted ${jvInserted}/${jvVouchers.length} JV vouchers...`);
      }
      console.log(`✓ Inserted ${jvInserted} JV vouchers, ${lineInserted} lines total`);

      // 4f. Final balance check
      const sumD = await tx.journal.aggregate({
        where: { fiscalYearId: fy.id },
        _sum: { debit: true, credit: true },
      });
      const finalD = Number(sumD._sum.debit ?? 0);
      const finalC = Number(sumD._sum.credit ?? 0);
      console.log(`\nFinal DB totals for FY2024-25:`);
      console.log(`  Σ(D) = ${finalD.toFixed(2)}`);
      console.log(`  Σ(C) = ${finalC.toFixed(2)}`);
      console.log(`  Diff = ${(finalD - finalC).toFixed(2)}`);
      if (Math.abs(finalD - finalC) > 0.01) {
        throw new Error(`DB-level imbalance after insert: ${(finalD - finalC).toFixed(2)}`);
      }

      if (dryRun) {
        console.log(`\n--dry-run set → rolling back.`);
        throw new Error("__DRY_RUN_ROLLBACK__");
      }
    },
    { maxWait: 60_000, timeout: 240_000, isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  ).catch((err) => {
    if (err instanceof Error && err.message === "__DRY_RUN_ROLLBACK__") {
      console.log(`✓ Dry-run completed — rolled back. Run without --dry-run to commit.`);
      return;
    }
    throw err;
  });

  if (!dryRun) {
    console.log(`\n✓ Step B complete. FY2024-25 imported.`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
