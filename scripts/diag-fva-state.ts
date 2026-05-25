/* eslint-disable */
// One-off: print every FairValueAdjustment row in the active FY plus
// every FV-prefixed journal voucher. Used to debug "I clicked Revalue
// to market and nothing happened" reports.
//
// Run: npx tsx scripts/diag-fva-state.ts

import { config } from "dotenv";
config({ path: ".env" });

import { PrismaClient } from "@/generated/prisma";

const prisma = new PrismaClient();

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}
function padR(s: string, n: number): string {
  return s.length >= n ? s : " ".repeat(n - s.length) + s;
}
function bdt(n: number): string {
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function main() {
  const fy = await prisma.fiscalYear.findFirst({
    orderBy: { startsOn: "desc" },
    select: { id: true, label: true },
  });
  if (!fy) throw new Error("No fiscal year");
  console.log(`Fiscal year: ${fy.label} (${fy.id})\n`);

  const fvas = await prisma.fairValueAdjustment.findMany({
    where: { fiscalYearId: fy.id },
    orderBy: { asOfDate: "asc" },
    include: { lines: true },
  });

  console.log(`=== FairValueAdjustment rows (${fvas.length}) ===`);
  console.log(
    `${pad("As-of", 12)} ${pad("Reversed?", 12)} ${padR("Unrealised P&L", 18)} ${padR("Σ deltaPosted", 18)} ${pad("Batch ID (head)", 12)}  ${pad("Created", 16)}`,
  );
  console.log("─".repeat(98));
  for (const a of fvas) {
    const totalDelta = a.lines.reduce((s, l) => s + Number(l.deltaPosted), 0);
    console.log(
      pad(a.asOfDate.toISOString().slice(0, 10), 12) +
        " " +
        pad(a.reversedAt ? "yes" : "no", 12) +
        " " +
        padR(bdt(Number(a.unrealisedPnl)), 18) +
        " " +
        padR(bdt(totalDelta), 18) +
        " " +
        pad(a.journalBatchId.slice(0, 8) + "…", 12) +
        "  " +
        pad(a.createdAt.toISOString().slice(0, 16).replace("T", " "), 16),
    );
  }

  console.log("");
  console.log("=== Journal vouchers with txnType='FV' in this FY ===");
  const fvLines = await prisma.journal.findMany({
    where: { fiscalYearId: fy.id, txnType: "FV" },
    orderBy: [{ entryDate: "asc" }, { voucherNo: "asc" }, { createdAt: "asc" }],
    select: {
      entryDate: true,
      voucherNo: true,
      batchId: true,
      accountName: true,
      debit: true,
      credit: true,
      instrumentCode: true,
      description: true,
    },
  });

  if (fvLines.length === 0) {
    console.log("  (no FV journal lines)");
  } else {
    // Group by batchId for legibility
    const byBatch = new Map<string, typeof fvLines>();
    for (const l of fvLines) {
      const k = l.batchId ?? "no-batch";
      if (!byBatch.has(k)) byBatch.set(k, [] as any);
      byBatch.get(k)!.push(l as any);
    }
    for (const [batch, lines] of byBatch) {
      const head = lines[0];
      const totalD = lines.reduce((s, l) => s + Number(l.debit), 0);
      const totalC = lines.reduce((s, l) => s + Number(l.credit), 0);
      console.log(
        `\n  ${head.voucherNo} · ${head.entryDate.toISOString().slice(0, 10)} · batch ${batch.slice(0, 8)}… · Σdr ${bdt(totalD)} Σcr ${bdt(totalC)}`,
      );
      for (const l of lines) {
        const d = Number(l.debit);
        const c = Number(l.credit);
        console.log(
          `    ${pad(l.accountName, 38)} ${pad(l.instrumentCode ?? "—", 10)}  ${padR(d > 0 ? bdt(d) : "", 14)}  ${padR(c > 0 ? bdt(c) : "", 14)}`,
        );
      }
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
