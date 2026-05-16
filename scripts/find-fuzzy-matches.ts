import { PrismaClient } from "../src/generated/prisma";

const MISSING = [
  "AIT Receivable against Management Fee",
  "Bkash (DM4952)",
  "Capital loss",
  "Dividend income",
  "Interest on Margin Loan",
  "Internet bill",
  "Liab For Employee Allowance",
  "Liab: For PF Fund",
  "Management Fee Accrued",
  "Membership Expenses",
  "Mobile Bill",
  "Office Equipment",
  "Salary and Allowances",
  "UCB BO (1205590068173895)",
  "Wages",
  "Withholding VAT & TDS",
];

function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3),
  );
}

function score(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;
  return common / Math.max(ta.size, tb.size);
}

async function main() {
  const prisma = new PrismaClient();
  const seeded = await prisma.chartOfAccount.findMany({ select: { name: true }, orderBy: { sl: "asc" } });
  await prisma.$disconnect();

  for (const m of MISSING) {
    const ranked = seeded
      .map((s) => ({ name: s.name, score: score(m, s.name) }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    console.log(`\n[MISSING] "${m}"`);
    if (ranked.length === 0) {
      console.log("  (no fuzzy match found)");
    } else {
      for (const r of ranked) {
        console.log(`  ${(r.score * 100).toFixed(0).padStart(3)}%  "${r.name}"`);
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
