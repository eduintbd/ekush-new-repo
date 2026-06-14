/* eslint-disable */
// Read-only: why doesn't the Balance Sheet balance? Runs diagnoseStatements
// for the latest open fiscal year and prints the cause.
//   npx tsx scripts/diag-statements.ts [fyLabel]

import { config } from "dotenv";
config({ path: ".env" });

import { PrismaClient } from "@/generated/prisma";
import { diagnoseStatements } from "@/lib/statement-diagnostics";

const prisma = new PrismaClient();
const fmt = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function main() {
  const wantLabel = process.argv[2];
  const fys = await prisma.fiscalYear.findMany({ orderBy: { startsOn: "desc" } });
  const fy = wantLabel ? fys.find((f) => f.label === wantLabel) : fys.find((f) => !f.isClosed) ?? fys[0];
  if (!fy) { console.log("No fiscal year found."); return; }
  console.log(`Diagnosing ${fy.label}${fy.isClosed ? " (closed)" : ""}\n`);

  const d = await diagnoseStatements(fy.id);
  console.log(`Trial balance balanced: ${d.tbBalanced ? "YES" : `NO (diff ${fmt(d.tbDiff)})`}`);
  console.log(`Balance sheet diff (Assets − E&L): ${fmt(d.bsDiff)}`);
  const n = d.natureView;
  console.log(`Nature-based: Assets ${fmt(n.assets)} | Liab ${fmt(n.liabilities)} | Equity ${fmt(n.equity)} | Profit ${fmt(n.profit)} | residual ${fmt(n.residual)}`);
  console.log(`\nVerdict: ${d.verdict}\n`);

  const droppedAnoms = d.signAnomalies.filter((a) => a.dropped);
  const harmlessAnoms = d.signAnomalies.filter((a) => !a.dropped);
  if (droppedAnoms.length) {
    console.log(`Accounts DROPPED from the statements (wrong side + mapping reads only the other side — these ARE the gap):`);
    console.log(`  ${"account".padEnd(44)} ${"normal".padStart(7)} ${"net Dr".padStart(15)} ${"net Cr".padStart(15)} ${"wrong-side".padStart(15)}`);
    for (const a of droppedAnoms)
      console.log(`  ${a.name.padEnd(44)} ${a.normalBalance.padStart(7)} ${fmt(a.netDebit).padStart(15)} ${fmt(a.netCredit).padStart(15)} ${fmt(a.wrongSide).padStart(15)}`);
    console.log("");
  }
  if (harmlessAnoms.length) {
    console.log(`Wrong-side accounts READ CORRECTLY (only the COA normalBalance flag is mislabelled — harmless):`);
    for (const a of harmlessAnoms)
      console.log(`  ${a.name.padEnd(44)} ${a.normalBalance.padStart(7)} net-${a.normalBalance === "DEBIT" ? "Cr" : "Dr"} ${fmt(a.wrongSide)}`);
    console.log("");
  }

  if (d.unclassifiedAccounts.length) {
    console.log(`Accounts with a balance but NO AccountGroup (unclassified):`);
    for (const a of d.unclassifiedAccounts) console.log(`  ${a.name.padEnd(44)} ${fmt(a.signed).padStart(15)}`);
    console.log("");
  }

  if (d.unmappedAccounts.length) {
    console.log(`Accounts with a TB balance but on NO statement line (the leak):`);
    console.log(`  ${"account".padEnd(44)} ${"net Dr".padStart(15)} ${"net Cr".padStart(15)} ${"signed".padStart(15)}`);
    for (const a of d.unmappedAccounts)
      console.log(`  ${a.name.padEnd(44)} ${fmt(a.netDebit).padStart(15)} ${fmt(a.netCredit).padStart(15)} ${fmt(a.signed).padStart(15)}`);
    console.log(`  ${"— signed total —".padEnd(44)} ${"".padStart(15)} ${"".padStart(15)} ${fmt(d.unmappedTotalSigned).padStart(15)}`);
  } else {
    console.log("No unmapped accounts.");
  }

  if (d.unbalancedVouchers.length) {
    console.log(`\nUnbalanced vouchers (Σdebit ≠ Σcredit):`);
    for (const v of d.unbalancedVouchers)
      console.log(`  ${v.voucherNo ?? v.batchId.slice(0, 8)}  Dr ${fmt(v.debit)}  Cr ${fmt(v.credit)}  diff ${fmt(v.diff)}`);
  } else {
    console.log("\nNo unbalanced vouchers.");
  }

  if (d.externalInputs.length) {
    console.log(`\nNon-journaled external inputs applied:`);
    for (const e of d.externalInputs) console.log(`  ${e.label}: ${fmt(e.amount)}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
