/* eslint-disable */
// Preview the year-end closing entries needed to make FY24-25 closing
// TB = FY25-26 OB. Two journals to be drafted at 2025-06-30:
//
//   JV/24-25/CLOSE-1: BS true-up adjustments (specific BS account
//                     movements that happened post-close but before
//                     FY25-26 OB was finalised)
//   JV/24-25/CLOSE-2: P&L closure to Retained Earnings (zero out all
//                     income/expense accounts at year-end)
//
// After these two posts, every account's closing FY24-25 balance ==
// FY25-26 OB balance.
//
// Output: scripts/output/fy24-25-closing-preview.xlsx
// No DB writes — review first, then run the matching post-script.

import { config } from "dotenv";
config({ path: ".env" });
import { PrismaClient } from "@/generated/prisma";
import ExcelJS from "exceljs";
import path from "node:path";
import fs from "node:fs";

const prisma = new PrismaClient();

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function main() {
  // 1. Load both FYs + their journals
  const fy24 = await prisma.fiscalYear.findFirst({ where: { label: "FY2024-25" } });
  const fy25 = await prisma.fiscalYear.findFirst({ where: { label: "FY2025-26" } });
  if (!fy24 || !fy25) {
    console.error("Need both FY2024-25 and FY2025-26 in DB");
    process.exit(1);
  }

  // 2. Closing TB of FY24-25 (= OB + all activity in the year)
  const lines24 = await prisma.journal.findMany({
    where: { fiscalYearId: fy24.id },
    select: { accountName: true, debit: true, credit: true },
  });
  const closing24 = new Map<string, number>();
  for (const l of lines24) {
    closing24.set(
      l.accountName,
      (closing24.get(l.accountName) ?? 0) + Number(l.debit) - Number(l.credit),
    );
  }
  for (const k of closing24.keys()) closing24.set(k, r2(closing24.get(k)!));

  // 3. OB of FY25-26
  const ob25 = await prisma.journal.findMany({
    where: { fiscalYearId: fy25.id, txnType: "OB" },
    select: { accountName: true, debit: true, credit: true },
  });
  const opening25 = new Map<string, number>();
  for (const l of ob25) {
    opening25.set(
      l.accountName,
      (opening25.get(l.accountName) ?? 0) + Number(l.debit) - Number(l.credit),
    );
  }
  for (const k of opening25.keys()) opening25.set(k, r2(opening25.get(k)!));

  // 4. Load CoA for metadata (normalBalance, group lineage for display)
  const coa = await prisma.chartOfAccount.findMany({
    include: { group: { include: { parent: { include: { parent: true } } } } },
  });
  type AccMeta = { name: string; normal: "DEBIT" | "CREDIT"; group: string };
  const accMeta = new Map<string, AccMeta>();
  for (const a of coa) {
    let curGroup: { name: string; parent?: { name: string; parent?: { name: string } } | null } | null =
      a.group as { name: string; parent?: { name: string; parent?: { name: string } } | null } | null;
    const lineage: string[] = [];
    while (curGroup) {
      lineage.push(curGroup.name);
      curGroup = curGroup.parent ?? null;
    }
    accMeta.set(a.name, {
      name: a.name,
      normal: a.normalBalance as "DEBIT" | "CREDIT",
      group: lineage.join(" > "),
    });
  }
  // Classification rule: any account with a non-zero balance in
  // FY25-26 OB is a BS account (the balance carries over). Accounts
  // with zero OB but non-zero closing in FY24-25 are P&L (close to RE).
  // Accounts named "Retained Earning" are handled specially (the plug).
  const isPL = (acc: string): boolean => {
    if (acc === "Retained Earning") return false;
    const ob = opening25.get(acc) ?? 0;
    return Math.abs(ob) < 0.01;
  };

  // 5. Compute the gap per account: target = opening25 - closing24
  type Gap = {
    account: string;
    closing24: number;
    ob25: number;
    delta: number; // target movement at FY24-25 close
    isPL: boolean;
    group: string;
    normal: "DEBIT" | "CREDIT" | "UNKNOWN";
  };
  const allAccs = new Set<string>([...closing24.keys(), ...opening25.keys()]);
  const gaps: Gap[] = [];
  for (const acc of allAccs) {
    const c = closing24.get(acc) ?? 0;
    const o = opening25.get(acc) ?? 0;
    const delta = r2(o - c);
    if (Math.abs(delta) < 0.01) continue;
    const m = accMeta.get(acc);
    gaps.push({
      account: acc,
      closing24: c,
      ob25: o,
      delta,
      isPL: isPL(acc),
      group: m?.group ?? "Uncategorised",
      normal: m?.normal ?? "UNKNOWN",
    });
  }

  // 6. Split into:
  //    A) P&L closure — all P&L accounts get closed to RE (move balance
  //       to 0 at year-end). The journal is: for each P&L account with
  //       balance X, post -X to that account and +X to Retained Earning.
  //    B) BS true-up — for every BS account with delta ≠ 0 (except RE),
  //       post the delta. The other side of the entry plugs Retained
  //       Earning (since these are post-close audit adjustments to
  //       prior year that booked through RE).
  const plGaps = gaps.filter((g) => g.isPL);
  const bsGaps = gaps.filter((g) => !g.isPL && g.account !== "Retained Earning");
  const reGap = gaps.find((g) => g.account === "Retained Earning");

  // 7. JV-1: BS true-up
  type Leg = { account: string; debit: number; credit: number; note?: string };
  const jv1: Leg[] = [];
  let jv1ReDebit = 0,
    jv1ReCredit = 0;
  for (const g of bsGaps) {
    // To move closing24 from c to o, we need delta = o - c on the BS side
    // (positive delta means need a DEBIT to that account; negative = CREDIT).
    if (g.delta > 0) {
      jv1.push({ account: g.account, debit: g.delta, credit: 0, note: g.group });
      jv1ReCredit += g.delta;
    } else {
      jv1.push({ account: g.account, debit: 0, credit: -g.delta, note: g.group });
      jv1ReDebit += -g.delta;
    }
  }
  // jv1ReCredit = total Dr to BS = total Cr to RE (other side of Dr-to-BS entries)
  // jv1ReDebit  = total Cr to BS = total Dr to RE (other side of Cr-to-BS entries)
  // Single RE plug = jv1ReDebit - jv1ReCredit (positive = Dr RE, negative = Cr RE)
  const jv1NetToRe = r2(jv1ReDebit - jv1ReCredit);
  if (Math.abs(jv1NetToRe) > 0) {
    if (jv1NetToRe > 0)
      jv1.push({
        account: "Retained Earning",
        debit: jv1NetToRe,
        credit: 0,
        note: "BS true-up plug",
      });
    else
      jv1.push({
        account: "Retained Earning",
        debit: 0,
        credit: -jv1NetToRe,
        note: "BS true-up plug",
      });
  }

  // 8. JV-2: P&L closure
  const jv2: Leg[] = [];
  let jv2ReDebit = 0,
    jv2ReCredit = 0;
  for (const g of plGaps) {
    // Closing balance c. To move it to 0, post the OPPOSITE: if c > 0
    // (debit-balance expense), CREDIT the account by c. If c < 0 (credit-
    // balance income), DEBIT the account by -c. The other side goes to RE.
    if (g.closing24 > 0) {
      jv2.push({ account: g.account, debit: 0, credit: g.closing24, note: g.group });
      jv2ReDebit += g.closing24;
    } else if (g.closing24 < 0) {
      jv2.push({ account: g.account, debit: -g.closing24, credit: 0, note: g.group });
      jv2ReCredit += -g.closing24;
    }
  }
  // jv2ReDebit = total expenses (each one Cr's the P&L → Dr's RE)
  // jv2ReCredit = total income (each one Dr's the P&L → Cr's RE)
  // Single RE plug = jv2ReDebit - jv2ReCredit
  // If positive: net loss (Dr RE — reduces RE)
  // If negative: net profit (Cr RE — increases RE)
  const jv2NetToRe = r2(jv2ReDebit - jv2ReCredit);
  if (Math.abs(jv2NetToRe) > 0) {
    if (jv2NetToRe > 0)
      jv2.push({
        account: "Retained Earning",
        debit: jv2NetToRe,
        credit: 0,
        note: "Net loss → reduces RE",
      });
    else
      jv2.push({
        account: "Retained Earning",
        debit: 0,
        credit: -jv2NetToRe,
        note: "Net profit → increases RE",
      });
  }

  const npat = -jv2NetToRe; // jv2NetToRe < 0 → profit (positive NPAT)

  // 9. Build preview workbook
  const wbOut = new ExcelJS.Workbook();
  wbOut.creator = "X-System";

  // Sheet: JV-1 BS true-up
  const s1 = wbOut.addWorksheet("JV CLOSE-1 (BS)");
  s1.columns = [
    { header: "Account", key: "acc", width: 50 },
    { header: "Group", key: "grp", width: 40 },
    { header: "Closing FY24-25", key: "c24", width: 18, style: { numFmt: "#,##0.00" } },
    { header: "OB FY25-26", key: "ob25", width: 18, style: { numFmt: "#,##0.00" } },
    { header: "Debit", key: "d", width: 16, style: { numFmt: "#,##0.00" } },
    { header: "Credit", key: "c", width: 16, style: { numFmt: "#,##0.00" } },
    { header: "Note", key: "note", width: 30 },
  ];
  s1.getRow(1).font = { bold: true };
  for (const g of bsGaps) {
    s1.addRow({
      acc: g.account,
      grp: g.group,
      c24: g.closing24,
      ob25: g.ob25,
      d: g.delta > 0 ? g.delta : 0,
      c: g.delta < 0 ? -g.delta : 0,
      note: g.group,
    });
  }
  // RE plug
  if (Math.abs(jv1NetToRe) > 0) {
    const re = s1.addRow({
      acc: "Retained Earning",
      grp: "(BS plug)",
      c24: "",
      ob25: "",
      d: jv1NetToRe < 0 ? -jv1NetToRe : 0,
      c: jv1NetToRe > 0 ? jv1NetToRe : 0,
      note: "BS true-up plug",
    });
    re.font = { bold: true };
  }
  const sum1 = s1.addRow({
    acc: "TOTAL",
    grp: "",
    d: jv1.reduce((s, l) => s + l.debit, 0),
    c: jv1.reduce((s, l) => s + l.credit, 0),
  });
  sum1.font = { bold: true };
  sum1.border = { top: { style: "thin" } };

  // Sheet: JV-2 P&L closure
  const s2 = wbOut.addWorksheet("JV CLOSE-2 (P&L)");
  s2.columns = [
    { header: "Account", key: "acc", width: 50 },
    { header: "Group", key: "grp", width: 40 },
    { header: "Closing FY24-25", key: "c24", width: 18, style: { numFmt: "#,##0.00" } },
    { header: "Debit", key: "d", width: 16, style: { numFmt: "#,##0.00" } },
    { header: "Credit", key: "c", width: 16, style: { numFmt: "#,##0.00" } },
  ];
  s2.getRow(1).font = { bold: true };
  for (const g of plGaps) {
    s2.addRow({
      acc: g.account,
      grp: g.group,
      c24: g.closing24,
      d: g.closing24 < 0 ? -g.closing24 : 0,
      c: g.closing24 > 0 ? g.closing24 : 0,
    });
  }
  const reLeg = jv2.find((l) => l.account === "Retained Earning");
  if (reLeg) {
    const re = s2.addRow({
      acc: "Retained Earning",
      grp: "(NPAT plug)",
      c24: "",
      d: reLeg.debit,
      c: reLeg.credit,
    });
    re.font = { bold: true };
  }
  const sum2 = s2.addRow({
    acc: "TOTAL",
    grp: "",
    d: jv2.reduce((s, l) => s + l.debit, 0),
    c: jv2.reduce((s, l) => s + l.credit, 0),
  });
  sum2.font = { bold: true };
  sum2.border = { top: { style: "thin" } };

  // Sheet: Verification
  const s3 = wbOut.addWorksheet("Verification (post-close)");
  s3.columns = [
    { header: "Account", key: "acc", width: 50 },
    { header: "Closing FY24-25 (current)", key: "c24", width: 22, style: { numFmt: "#,##0.00" } },
    { header: "Movement (JV-1)", key: "j1", width: 16, style: { numFmt: "#,##0.00" } },
    { header: "Movement (JV-2)", key: "j2", width: 16, style: { numFmt: "#,##0.00" } },
    { header: "After close (FY24-25)", key: "after", width: 20, style: { numFmt: "#,##0.00" } },
    { header: "OB FY25-26", key: "ob25", width: 18, style: { numFmt: "#,##0.00" } },
    { header: "Match?", key: "match", width: 8 },
  ];
  s3.getRow(1).font = { bold: true };
  for (const acc of [...allAccs].sort()) {
    const c = closing24.get(acc) ?? 0;
    const o = opening25.get(acc) ?? 0;
    const j1 =
      (jv1.find((l) => l.account === acc)?.debit ?? 0) -
      (jv1.find((l) => l.account === acc)?.credit ?? 0);
    const j2 =
      (jv2.find((l) => l.account === acc)?.debit ?? 0) -
      (jv2.find((l) => l.account === acc)?.credit ?? 0);
    const after = r2(c + j1 + j2);
    const match = Math.abs(after - o) < 0.01 ? "✓" : "✗";
    const row = s3.addRow({ acc, c24: c, j1, j2, after, ob25: o, match });
    if (match !== "✓") {
      row.getCell("match").fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFFAD4D4" },
      };
    }
  }

  // Cover sheet
  const sCover = wbOut.addWorksheet("0. Read me first");
  sCover.getColumn(1).width = 110;
  const lines = [
    `FY 2024-25 YEAR-END CLOSING — PREVIEW`,
    ``,
    `Two journal vouchers will be drafted for posting on 2025-06-30:`,
    ``,
    `  JV/24-25/CLOSE-1 (BS true-up): ${jv1.length} lines, Σ(D)=${jv1.reduce((s, l) => s + l.debit, 0).toFixed(2)}, Σ(C)=${jv1.reduce((s, l) => s + l.credit, 0).toFixed(2)}`,
    `    Adjusts ${bsGaps.length} BS account(s) to match FY25-26 opening`,
    `    Other side plugs through Retained Earning (post-close audit adjustments)`,
    ``,
    `  JV/24-25/CLOSE-2 (P&L closure): ${jv2.length} lines, Σ(D)=${jv2.reduce((s, l) => s + l.debit, 0).toFixed(2)}, Σ(C)=${jv2.reduce((s, l) => s + l.credit, 0).toFixed(2)}`,
    `    Closes ${plGaps.length} P&L account(s) to Retained Earning`,
    `    Net P&L (NPAT): ${npat >= 0 ? "+" : ""}${npat.toFixed(2)}  (${npat >= 0 ? "profit" : "loss"})`,
    ``,
    `Expected RE movement: ${reGap?.delta.toFixed(2) ?? "—"}`,
    `  = NPAT (${npat.toFixed(2)}) + BS-true-up RE plug (${-jv1NetToRe.toFixed(2)})`,
    `  Net delta to RE: ${(npat + -jv1NetToRe).toFixed(2)}`,
    ``,
    `Tabs:`,
    `  JV CLOSE-1 (BS)         — BS true-up entries`,
    `  JV CLOSE-2 (P&L)        — P&L → RE closure`,
    `  Verification (post-close)     — every account: closing + movements = OB?`,
    ``,
    `If verification has all ✓ rows, say "go" to post these two JVs.`,
    `Same idempotency as the import script: re-running will wipe + re-post.`,
  ];
  for (const l of lines) sCover.addRow([l]);
  sCover.getRow(1).font = { bold: true, size: 14 };

  // Save
  const outDir = path.join(process.cwd(), "scripts", "output");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "fy24-25-closing-preview.xlsx");
  await wbOut.xlsx.writeFile(outPath);

  console.log(`✓ Wrote ${outPath}`);
  console.log(`JV-1 (BS): ${jv1.length} lines, Σ(D)=${jv1.reduce((s, l) => s + l.debit, 0).toFixed(2)} / Σ(C)=${jv1.reduce((s, l) => s + l.credit, 0).toFixed(2)}`);
  console.log(`JV-2 (PL): ${jv2.length} lines, Σ(D)=${jv2.reduce((s, l) => s + l.debit, 0).toFixed(2)} / Σ(C)=${jv2.reduce((s, l) => s + l.credit, 0).toFixed(2)}`);
  console.log(`NPAT: ${npat.toFixed(2)}`);
  console.log(`RE plug needed: ${-jv1NetToRe.toFixed(2)}`);
  console.log(`Expected RE delta: ${reGap?.delta.toFixed(2) ?? "—"}`);

  // Pre-flight verification check
  let allMatch = true;
  let mismatches = 0;
  for (const acc of allAccs) {
    const c = closing24.get(acc) ?? 0;
    const o = opening25.get(acc) ?? 0;
    const j1 =
      (jv1.find((l) => l.account === acc)?.debit ?? 0) -
      (jv1.find((l) => l.account === acc)?.credit ?? 0);
    const j2 =
      (jv2.find((l) => l.account === acc)?.debit ?? 0) -
      (jv2.find((l) => l.account === acc)?.credit ?? 0);
    const after = r2(c + j1 + j2);
    if (Math.abs(after - o) >= 0.01) {
      allMatch = false;
      mismatches++;
      if (mismatches <= 10) console.log(`  MISMATCH: ${acc}  after=${after}  ob25=${o}`);
    }
  }
  console.log(`\nVerification: ${allMatch ? "✓ ALL ACCOUNTS MATCH" : `✗ ${mismatches} mismatches`}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
