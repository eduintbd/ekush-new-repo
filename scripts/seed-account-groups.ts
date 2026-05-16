// Seed standard Account Groups + backfill ChartOfAccount.groupId for
// every existing account using a heuristic based on name + normalBalance.
// Idempotent. Run with `npx tsx scripts/seed-account-groups.ts`.

import { PrismaClient } from "../src/generated/prisma";

type Nature = "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "EXPENSE";

const GROUPS: Array<{ name: string; nature: Nature; parent?: string; sortOrder?: number; description?: string }> = [
  // Top-level
  { name: "Assets", nature: "ASSET", sortOrder: 10 },
  { name: "Liabilities", nature: "LIABILITY", sortOrder: 20 },
  { name: "Equity", nature: "EQUITY", sortOrder: 30 },
  { name: "Income", nature: "INCOME", sortOrder: 40 },
  { name: "Expenses", nature: "EXPENSE", sortOrder: 50 },

  // Assets — children
  { name: "Non-current assets", nature: "ASSET", parent: "Assets", sortOrder: 1 },
  { name: "Property, plant and equipment", nature: "ASSET", parent: "Non-current assets", sortOrder: 1 },
  { name: "Long-term investments", nature: "ASSET", parent: "Non-current assets", sortOrder: 2 },
  { name: "Long-term receivables", nature: "ASSET", parent: "Non-current assets", sortOrder: 3 },
  { name: "Current assets", nature: "ASSET", parent: "Assets", sortOrder: 2 },
  { name: "Cash and bank balances", nature: "ASSET", parent: "Current assets", sortOrder: 1 },
  { name: "Receivables", nature: "ASSET", parent: "Current assets", sortOrder: 2 },
  { name: "Short-term investments", nature: "ASSET", parent: "Current assets", sortOrder: 3 },
  { name: "Prepayments and advances", nature: "ASSET", parent: "Current assets", sortOrder: 4 },

  // Liabilities — children
  { name: "Non-current liabilities", nature: "LIABILITY", parent: "Liabilities", sortOrder: 1 },
  { name: "Long-term borrowings", nature: "LIABILITY", parent: "Non-current liabilities", sortOrder: 1 },
  { name: "Current liabilities", nature: "LIABILITY", parent: "Liabilities", sortOrder: 2 },
  { name: "Accruals and payables", nature: "LIABILITY", parent: "Current liabilities", sortOrder: 1 },
  { name: "Withholding and taxes payable", nature: "LIABILITY", parent: "Current liabilities", sortOrder: 2 },
  { name: "Provisions", nature: "LIABILITY", parent: "Current liabilities", sortOrder: 3 },

  // Equity — children
  { name: "Share capital", nature: "EQUITY", parent: "Equity", sortOrder: 1 },
  { name: "Reserves", nature: "EQUITY", parent: "Equity", sortOrder: 2 },

  // Income — children
  { name: "Operating income", nature: "INCOME", parent: "Income", sortOrder: 1 },
  { name: "Finance income", nature: "INCOME", parent: "Income", sortOrder: 2 },
  { name: "Other income", nature: "INCOME", parent: "Income", sortOrder: 3 },

  // Expenses — children
  { name: "Operating expenses", nature: "EXPENSE", parent: "Expenses", sortOrder: 1 },
  { name: "Finance expenses", nature: "EXPENSE", parent: "Expenses", sortOrder: 2 },
  { name: "Tax expenses", nature: "EXPENSE", parent: "Expenses", sortOrder: 3 },
  { name: "Uncategorised", nature: "EXPENSE", parent: "Expenses", sortOrder: 99, description: "Catch-all bucket for accounts not yet classified." },
];

// Heuristic classifier: returns a leaf group name (not a parent).
function classify(name: string, normalBalance: string, category: string | null): string {
  const n = name.toLowerCase();
  const c = (category ?? "").toLowerCase();

  // Specific overrides first (handle weird cases)
  if (/management fee$/.test(n) || /management fee income/.test(n)) return "Operating income";
  if (/management fee accrued/.test(n) || /accrued management fee/.test(n)) return "Receivables";
  if (/dividend/.test(n) && /receivable/.test(n)) return "Receivables";
  if (/dividend/.test(n)) return normalBalance === "CREDIT" ? "Operating income" : "Receivables";
  if (/interest/.test(n) && /payable/.test(n)) return "Accruals and payables";
  if (/interest/.test(n) && /(income|received)/.test(n)) return "Finance income";
  if (/interest/.test(n)) return normalBalance === "CREDIT" ? "Finance income" : "Finance expenses";
  if (/capital gain/.test(n)) return "Operating income";
  if (/capital loss/.test(n)) return "Operating expenses";

  // Cash & bank
  if (/(cash|bank|brac|ucb|bkash|nagad|rocket|mtbl|dbbl|ebl|std account|midland|premier|prime|nccb|sonali|janata|agrani|rupali|ab bank|city bank|dutch|eastern)/.test(n)
      || /cash|bank/.test(c)) {
    if (normalBalance === "DEBIT") return "Cash and bank balances";
  }

  // Receivables
  if (/receivable/.test(n) || /\bait\b/.test(n)) return "Receivables";

  // Investments
  if (/investment/.test(n) || /placement/.test(n) || /\bipo\b/.test(n)) {
    if (/short[- ]?term|listed|share|mutual fund/.test(n)) return "Short-term investments";
    return "Long-term investments";
  }

  // PPE
  if (/(computer|office equipment|office equipments|office decoration|furniture|vehicle|building|land)/.test(n)) {
    return "Property, plant and equipment";
  }
  if (/depreciation/.test(n)) {
    return "Property, plant and equipment";
  }

  // Deposits and prepayments
  if (/deposit/.test(n) || /prepay/.test(n) || /advance/.test(n)) {
    return "Prepayments and advances";
  }

  // Equity
  if (/share capital/.test(n)) return "Share capital";
  if (/(retained|reserve|fair value)/.test(n)) return "Reserves";

  // Withholding and taxes payable
  if (/(withhold|vat|tds|vds|tax payable|ait & vat)/.test(n)) return "Withholding and taxes payable";
  if (/provision.*tax|provision.*income tax/.test(n)) return "Tax expenses";
  if (/provision/.test(n)) return "Provisions";

  // Long-term borrowings
  if (/(loan|borrowing|debenture)/.test(n)) {
    return "Long-term borrowings";
  }

  // Liabilities — accruals & payables
  if (/(payable|accrued|liab[: ]|liability)/.test(n)) {
    return "Accruals and payables";
  }

  // Income (credit-normal accounts not matched above)
  if (normalBalance === "CREDIT") {
    if (/income|fee|revenue/.test(n)) return "Operating income";
    if (/grant|gain/.test(n)) return "Other income";
    return "Other income";
  }

  // Default expense buckets
  if (/(rent|salary|wage|utility|electric|water|gas|internet|telephone|mobile bill|membership|audit fee|legal|consult|travel|conveyance|stationery|printing|repair|maintenance|insurance|advert|marketing|training|donation|cleaning|courier|misc)/.test(n)) {
    return "Operating expenses";
  }
  if (/charge|charges|commission/.test(n)) return "Finance expenses";

  return "Uncategorised";
}

async function main() {
  const prisma = new PrismaClient();

  // 1. Seed groups (in dependency order: parents first)
  console.log("Seeding account groups…");
  const seeded = new Map<string, string>(); // name -> id
  // Insert in order so parents exist before children.
  for (const g of GROUPS) {
    const parentId = g.parent ? seeded.get(g.parent) ?? null : null;
    const row = await prisma.accountGroup.upsert({
      where: { name: g.name },
      create: {
        name: g.name,
        parentId,
        nature: g.nature,
        sortOrder: g.sortOrder ?? 0,
        description: g.description,
        isReserved: true,
      },
      update: {
        parentId,
        nature: g.nature,
        sortOrder: g.sortOrder ?? 0,
        description: g.description,
      },
    });
    seeded.set(g.name, row.id);
  }
  console.log(`  ${seeded.size} groups upserted.`);

  // 2. Backfill ChartOfAccount.groupId
  console.log("\nBackfilling ChartOfAccount.groupId…");
  const accounts = await prisma.chartOfAccount.findMany({
    where: { groupId: null },
    select: { id: true, name: true, normalBalance: true, category: true },
  });
  console.log(`  ${accounts.length} accounts need a group assignment.`);

  const histo = new Map<string, number>();
  for (const a of accounts) {
    const groupName = classify(a.name, a.normalBalance, a.category);
    const groupId = seeded.get(groupName);
    if (!groupId) {
      console.warn(`  WARN: no group for "${a.name}" -> "${groupName}"`);
      continue;
    }
    await prisma.chartOfAccount.update({ where: { id: a.id }, data: { groupId } });
    histo.set(groupName, (histo.get(groupName) ?? 0) + 1);
  }

  console.log("\nClassification histogram:");
  for (const [g, n] of [...histo.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${g}`);
  }

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
