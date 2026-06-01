import { config } from "dotenv";
config({ path: ".env" });
import { PrismaClient } from "@/generated/prisma";

const prisma = new PrismaClient();

async function main() {
  // 1. Counts per FY
  const fys = await prisma.fiscalYear.findMany({ orderBy: { startsOn: "asc" } });
  console.log("Fiscal years now in DB:");
  for (const fy of fys) {
    const total = await prisma.journal.count({ where: { fiscalYearId: fy.id } });
    const ob = await prisma.journal.count({ where: { fiscalYearId: fy.id, txnType: "OB" } });
    const sum = await prisma.journal.aggregate({
      where: { fiscalYearId: fy.id },
      _sum: { debit: true, credit: true },
    });
    const d = Number(sum._sum.debit ?? 0);
    const c = Number(sum._sum.credit ?? 0);
    console.log(`  ${fy.label}  ${fy.startsOn.toISOString().slice(0, 10)} → ${fy.endsOn.toISOString().slice(0, 10)}`);
    console.log(`    lines:${total}  OB lines:${ob}  Σ(D)=${d.toFixed(2)}  Σ(C)=${c.toFixed(2)}  diff=${(d - c).toFixed(2)}`);
  }

  // 2. Closing TB of FY24-25 vs Opening TB of FY25-26
  const fy24 = await prisma.fiscalYear.findFirst({ where: { label: "FY2024-25" } });
  const fy25 = await prisma.fiscalYear.findFirst({ where: { label: "FY2025-26" } });
  if (!fy24 || !fy25) return;

  // Closing TB of FY24-25 = OB of FY24-25 + activity through 2025-06-30
  const lines24 = await prisma.journal.findMany({
    where: { fiscalYearId: fy24.id },
    select: { accountName: true, debit: true, credit: true },
  });
  const closing24 = new Map<string, number>();
  for (const l of lines24) {
    closing24.set(l.accountName, (closing24.get(l.accountName) ?? 0) + Number(l.debit) - Number(l.credit));
  }
  // Round to nearest paisa
  for (const k of closing24.keys()) closing24.set(k, Math.round(closing24.get(k)! * 100) / 100);

  // Opening TB of FY25-26 (the OB rows already in DB)
  const ob25 = await prisma.journal.findMany({
    where: { fiscalYearId: fy25.id, txnType: "OB" },
    select: { accountName: true, debit: true, credit: true },
  });
  const ob25Net = new Map<string, number>();
  for (const l of ob25) {
    ob25Net.set(l.accountName, (ob25Net.get(l.accountName) ?? 0) + Number(l.debit) - Number(l.credit));
  }
  for (const k of ob25Net.keys()) ob25Net.set(k, Math.round(ob25Net.get(k)! * 100) / 100);

  // Compare
  const allAccs = new Set<string>([...closing24.keys(), ...ob25Net.keys()]);
  const matches: Array<{ acc: string; closing24: number; ob25: number; diff: number }> = [];
  for (const acc of allAccs) {
    const c24 = closing24.get(acc) ?? 0;
    const ob = ob25Net.get(acc) ?? 0;
    const diff = Math.round((c24 - ob) * 100) / 100;
    matches.push({ acc, closing24: c24, ob25: ob, diff });
  }
  matches.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

  console.log(`\n─── Reconciliation: closing FY24-25 vs OB FY25-26 ───`);
  console.log(`Accounts with |diff| > ₹1:`);
  let bigDiff = 0;
  for (const m of matches) {
    if (Math.abs(m.diff) <= 1) continue;
    bigDiff++;
    console.log(`  ${m.acc.padEnd(50)} closing24=${m.closing24.toFixed(2).padStart(14)}  ob25=${m.ob25.toFixed(2).padStart(14)}  diff=${m.diff.toFixed(2).padStart(14)}`);
  }
  console.log(`\nTotal accounts compared: ${matches.length}`);
  console.log(`Matched within ₹1: ${matches.length - bigDiff}`);
  console.log(`Differ by > ₹1: ${bigDiff}`);

  // 3. Monthly summary (this is what the user wants for QoQ / MoM comparison)
  const allLines = await prisma.journal.findMany({
    where: { fiscalYearId: { in: [fy24.id, fy25.id] } },
    select: { entryDate: true, debit: true, credit: true, fiscalYearId: true },
  });
  const monthly = new Map<string, { D: number; C: number; fy: string }>();
  for (const l of allLines) {
    const ym = l.entryDate.toISOString().slice(0, 7);
    const fyLabel = l.fiscalYearId === fy24.id ? "24-25" : "25-26";
    const k = `${ym}|${fyLabel}`;
    const t = monthly.get(k) ?? { D: 0, C: 0, fy: fyLabel };
    t.D += Number(l.debit);
    t.C += Number(l.credit);
    monthly.set(k, t);
  }
  console.log(`\n─── Monthly D/C totals (FY24-25 + FY25-26) ───`);
  console.log(`Month    | FY      | Debit             | Credit            | Net`);
  console.log("─".repeat(90));
  const sortedKeys = Array.from(monthly.keys()).sort();
  for (const k of sortedKeys) {
    const t = monthly.get(k)!;
    const [ym] = k.split("|");
    console.log(`${ym}  | ${t.fy}  | ${t.D.toFixed(2).padStart(17)} | ${t.C.toFixed(2).padStart(17)} | ${(t.D - t.C).toFixed(2).padStart(17)}`);
  }
}
main().finally(() => prisma.$disconnect());
