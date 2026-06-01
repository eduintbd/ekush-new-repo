/* eslint-disable */
// Per-agent commission calculator. Pulls every executed transaction for
// the investors a given agent has sourced, applies the agent's active
// term rates per fund category, and writes an Excel workbook so the
// admin can verify the math line-by-line.
//
// Three sheets:
//   1. Summary       — one row per (investor, fund) with totals
//   2. Transactions  — every BUY / SELL with applicable rate + commission
//   3. Terms used    — resolved term rows + a "flagged" column for any
//                      values that look like raw percentages (>= 0.01)
//                      vs proper decimals (< 0.01) — typical data-entry
//                      error.
//
// Usage:
//   npx tsx scripts/calc-agent-commissions.ts BR0000
//
// Output:
//   scripts/output/agent-commissions-{agentCode}-{YYYY-MM-DD}.xlsx

import { config } from "dotenv";
config({ path: ".env" });

import { PrismaClient } from "@/generated/prisma";
import ExcelJS from "exceljs";
import { categoryForFund, type FundCode } from "@/lib/ekush-web/types";
import path from "node:path";
import fs from "node:fs";

const prisma = new PrismaClient();

type Term = {
  fundCategory: "equity" | "fixed_income";
  upfrontPct: number;
  trailY1PctPa: number;
  trailY2PlusPctPa: number;
  clawbackMonths: number;
  clawbackPct: number;
  effectiveFrom: Date;
  effectiveTo: Date | null;
};

type Tx = {
  date: Date;
  investorCode: string;
  fundCode: FundCode;
  direction: "BUY" | "SELL";
  units: number;
  amount: number;
  nav: number | null;
  channel: string;
};

function addMonths(d: Date, months: number): Date {
  const n = new Date(d);
  n.setUTCMonth(n.getUTCMonth() + months);
  return n;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Pick the LATEST effective term for a category as of `asOf`. The
 *  commission engine's pickTerm uses .find() which returns the first
 *  match in arbitrary array order — this implementation sorts by
 *  effectiveFrom DESC first, so the most-recent applicable term wins. */
function pickActiveTerm(
  terms: Term[],
  category: "equity" | "fixed_income",
  asOf: Date,
): Term | null {
  const sorted = terms
    .filter(
      (t) =>
        t.fundCategory === category &&
        t.effectiveFrom <= asOf &&
        (t.effectiveTo === null || t.effectiveTo > asOf),
    )
    .sort((a, b) => +b.effectiveFrom - +a.effectiveFrom);
  return sorted[0] ?? null;
}

async function main() {
  const agentCode = process.argv[2];
  if (!agentCode) {
    console.error("usage: tsx scripts/calc-agent-commissions.ts <agent-code>");
    process.exit(1);
  }
  const asOf = new Date();
  const asOfStr = asOf.toISOString().slice(0, 10);

  // 1. Load the agent + terms + investor links
  const agent = await prisma.sellingAgent.findUnique({
    where: { code: agentCode },
    include: { terms: true, investors: { orderBy: { sourcedOn: "asc" } } },
  });
  if (!agent) {
    console.error(`Agent with code "${agentCode}" not found.`);
    process.exit(1);
  }
  console.log(`Agent: ${agent.code} — ${agent.fullName}  (${agent.status})`);
  console.log(`Term rows: ${agent.terms.length}, investor links: ${agent.investors.length}`);

  const terms: Term[] = agent.terms.map((t) => ({
    fundCategory: t.fundCategory as "equity" | "fixed_income",
    upfrontPct: Number(t.upfrontPct),
    trailY1PctPa: Number(t.trailY1PctPa),
    trailY2PlusPctPa: Number(t.trailY2PlusPctPa),
    clawbackMonths: t.clawbackMonths,
    clawbackPct: Number(t.clawbackPct),
    effectiveFrom: t.effectiveFrom,
    effectiveTo: t.effectiveTo,
  }));

  // 2. Pull every executed transaction for the agent's investor cohort.
  // Pre-cohort means we miss transactions BEFORE the link, but those
  // weren't sourced by this agent anyway.
  const investorCodes = Array.from(new Set(agent.investors.map((l) => l.investorCode)));
  const portalInvestors = await prisma.$queryRawUnsafe<
    Array<{ id: string; investorCode: string; name: string | null }>
  >(
    `SELECT id, "investorCode", name FROM public.investors WHERE "investorCode" = ANY($1::text[])`,
    investorCodes,
  );
  const portalFunds = await prisma.$queryRawUnsafe<
    Array<{ id: string; code: string }>
  >(`SELECT id, code FROM public.funds`);
  const invIdByCode = new Map(portalInvestors.map((i) => [i.investorCode, i.id]));
  const invNameById = new Map(portalInvestors.map((i) => [i.id, i.name ?? ""]));
  const codeByInvId = new Map(portalInvestors.map((i) => [i.id, i.investorCode]));
  const fundIdByCode = new Map(portalFunds.map((f) => [f.code, f.id]));
  const codeByFundId = new Map(portalFunds.map((f) => [f.id, f.code]));

  const txnRows = await prisma.$queryRawUnsafe<
    Array<{
      investorId: string;
      fundId: string;
      date: Date;
      direction: string;
      units: any;
      amount: any;
      nav: any;
      channel: string;
    }>
  >(
    `SELECT "investorId", "fundId", "orderDate" AS date, direction, units, amount, nav, channel
     FROM public.transactions
     WHERE "investorId" = ANY($1::text[])
       AND "fundId" = ANY($2::text[])
       AND status = 'EXECUTED'
     ORDER BY "orderDate" ASC, "createdAt" ASC`,
    portalInvestors.map((i) => i.id),
    portalFunds.map((f) => f.id),
  );

  // Filter transactions to only those at-or-after the agent's link
  // (sourced-on). Anything earlier wasn't introduced by THIS agent.
  const linkByPair = new Map<string, Date>();
  for (const l of agent.investors) {
    linkByPair.set(`${l.investorCode}|${l.fundCode}`, l.sourcedOn);
  }

  const txns: Tx[] = [];
  for (const t of txnRows) {
    const invCode = codeByInvId.get(t.investorId);
    const fundCode = codeByFundId.get(t.fundId);
    if (!invCode || !fundCode) continue;
    const linkDate = linkByPair.get(`${invCode}|${fundCode}`);
    if (!linkDate) continue; // not linked to this agent for this fund
    if (t.date < linkDate) continue; // pre-sourcing — not credited
    txns.push({
      date: t.date,
      investorCode: invCode,
      fundCode: fundCode as FundCode,
      direction: t.direction as "BUY" | "SELL",
      units: Number(t.units),
      amount: Number(t.amount ?? 0),
      nav: t.nav != null ? Number(t.nav) : null,
      channel: t.channel ?? "",
    });
  }
  console.log(`Transactions credited to ${agent.code}: ${txns.length}`);

  // 3. Build Excel workbook
  const wb = new ExcelJS.Workbook();
  wb.creator = "X-System";
  wb.created = new Date();

  // ─── Sheet 3 first (Terms used) — most critical for verification ───
  const termsSheet = wb.addWorksheet("Terms used");
  termsSheet.columns = [
    { header: "Fund category", key: "cat", width: 16 },
    { header: "Effective from", key: "from", width: 14 },
    { header: "Effective to", key: "to", width: 14 },
    { header: "Upfront %", key: "up", width: 12 },
    { header: "Trail Y1 % p.a.", key: "y1", width: 14 },
    { header: "Trail Y2+ % p.a.", key: "y2", width: 16 },
    { header: "Clawback months", key: "cm", width: 16 },
    { header: "Clawback %", key: "cp", width: 12 },
    { header: "Flag", key: "flag", width: 50 },
  ];
  termsSheet.getRow(1).font = { bold: true };
  for (const t of [...terms].sort(
    (a, b) =>
      (a.fundCategory > b.fundCategory ? 1 : -1) ||
      +b.effectiveFrom - +a.effectiveFrom,
  )) {
    const flags: string[] = [];
    if (t.upfrontPct >= 0.01) flags.push(`upfrontPct=${t.upfrontPct} (likely entered as percent literal — should be ${(t.upfrontPct / 100).toFixed(4)})`);
    if (t.trailY1PctPa >= 0.05) flags.push(`trailY1=${t.trailY1PctPa} (>5% p.a. unusual; check)`);
    if (t.trailY2PlusPctPa >= 0.05) flags.push(`trailY2+=${t.trailY2PlusPctPa} (>5% p.a. unusual; check)`);
    termsSheet.addRow({
      cat: t.fundCategory,
      from: t.effectiveFrom.toISOString().slice(0, 10),
      to: t.effectiveTo ? t.effectiveTo.toISOString().slice(0, 10) : "—",
      up: t.upfrontPct,
      y1: t.trailY1PctPa,
      y2: t.trailY2PlusPctPa,
      cm: t.clawbackMonths,
      cp: t.clawbackPct,
      flag: flags.join("; "),
    });
  }

  // ─── Sheet 2 (Transactions detail) ───
  const txSheet = wb.addWorksheet("Transactions");
  txSheet.columns = [
    { header: "Date", key: "date", width: 12 },
    { header: "Investor", key: "inv", width: 10 },
    { header: "Investor name", key: "name", width: 28 },
    { header: "Fund", key: "fund", width: 8 },
    { header: "Category", key: "cat", width: 14 },
    { header: "Channel", key: "ch", width: 8 },
    { header: "Direction", key: "dir", width: 10 },
    { header: "Units", key: "units", width: 12, style: { numFmt: "#,##0.00" } },
    { header: "Amount (BDT)", key: "amount", width: 16, style: { numFmt: "#,##0.00" } },
    { header: "NAV at txn", key: "nav", width: 12, style: { numFmt: "#,##0.0000" } },
    { header: "Upfront %", key: "rate", width: 12, style: { numFmt: "0.0000%" } },
    { header: "Upfront commission (BDT)", key: "comm", width: 24, style: { numFmt: "#,##0.00" } },
    { header: "Notes", key: "notes", width: 40 },
  ];
  txSheet.getRow(1).font = { bold: true };
  // Freeze top row
  txSheet.views = [{ state: "frozen", ySplit: 1 }];

  // Calculate commission per transaction.
  // Practical model: every BUY earns upfront (since the agent introduces
  // each subscription including SIP installments). Per the spec the
  // engine only counts the INITIAL sourcing as upfront; that
  // discrepancy is noted in Sheet 1.
  let totalCommission = 0;
  type Bucket = {
    investorCode: string;
    name: string;
    fundCode: FundCode;
    category: string;
    sourcedOn: Date;
    inflowTotal: number;
    outflowTotal: number;
    unitsBought: number;
    unitsSold: number;
    initialUpfront: number; // per-spec (engine) upfront
    perInflowUpfront: number; // practical (every-BUY) upfront
    txCount: number;
  };
  const buckets = new Map<string, Bucket>();

  for (const t of txns) {
    const category = categoryForFund(t.fundCode);
    const term = pickActiveTerm(terms, category, t.date);
    const rate = term?.upfrontPct ?? 0;
    const isBuy = t.direction === "BUY";
    const commission = isBuy ? round2(t.amount * rate) : 0;
    totalCommission += commission;

    const key = `${t.investorCode}|${t.fundCode}`;
    let b = buckets.get(key);
    if (!b) {
      const sourcedOn = linkByPair.get(key)!;
      b = {
        investorCode: t.investorCode,
        name: invNameById.get(invIdByCode.get(t.investorCode) ?? "") ?? "",
        fundCode: t.fundCode,
        category,
        sourcedOn,
        inflowTotal: 0,
        outflowTotal: 0,
        unitsBought: 0,
        unitsSold: 0,
        initialUpfront: 0,
        perInflowUpfront: 0,
        txCount: 0,
      };
      buckets.set(key, b);
    }
    b.txCount += 1;
    if (isBuy) {
      b.inflowTotal += t.amount;
      b.unitsBought += t.units;
      b.perInflowUpfront += commission;
    } else {
      b.outflowTotal += t.amount;
      b.unitsSold += t.units;
    }

    // Mark per-spec initial-only upfront on the first BUY at-or-after sourcedOn
    const link = agent.investors.find(
      (l) => l.investorCode === t.investorCode && l.fundCode === t.fundCode,
    );
    const isInitial =
      isBuy &&
      link != null &&
      t.date.toISOString().slice(0, 10) === link.sourcedOn.toISOString().slice(0, 10) &&
      b.initialUpfront === 0;
    if (isInitial) {
      const initialGross = Number(link!.initialUnits) * Number(link!.unitPriceAtSourcing);
      b.initialUpfront = round2(initialGross * rate);
    }

    txSheet.addRow({
      date: t.date.toISOString().slice(0, 10),
      inv: t.investorCode,
      name: invNameById.get(invIdByCode.get(t.investorCode) ?? "") ?? "",
      fund: t.fundCode,
      cat: category,
      ch: t.channel,
      dir: t.direction,
      units: t.units,
      amount: t.amount,
      nav: t.nav ?? "",
      rate: rate,
      comm: commission,
      notes: term ? "" : "No active term for this category on this date — rate=0",
    });
  }

  // ─── Sheet 1 (Summary) ───
  const sumSheet = wb.addWorksheet("Summary");
  sumSheet.columns = [
    { header: "Investor", key: "inv", width: 10 },
    { header: "Name", key: "name", width: 28 },
    { header: "Fund", key: "fund", width: 8 },
    { header: "Category", key: "cat", width: 14 },
    { header: "Sourced on", key: "sourced", width: 12 },
    { header: "# Txns", key: "n", width: 8, style: { numFmt: "#,##0" } },
    { header: "Total inflow (BDT)", key: "inflow", width: 18, style: { numFmt: "#,##0.00" } },
    { header: "Total outflow (BDT)", key: "outflow", width: 18, style: { numFmt: "#,##0.00" } },
    { header: "Net inflow (BDT)", key: "net", width: 18, style: { numFmt: "#,##0.00" } },
    { header: "Units bought", key: "ub", width: 12, style: { numFmt: "#,##0.00" } },
    { header: "Units sold", key: "us", width: 12, style: { numFmt: "#,##0.00" } },
    { header: "Per-spec upfront (initial only)", key: "initU", width: 28, style: { numFmt: "#,##0.00" } },
    { header: "Per-inflow upfront (every BUY)", key: "everyU", width: 28, style: { numFmt: "#,##0.00" } },
  ];
  sumSheet.getRow(1).font = { bold: true };
  sumSheet.views = [{ state: "frozen", ySplit: 1 }];

  let totInflow = 0,
    totOutflow = 0,
    totInitial = 0,
    totEvery = 0;
  const sortedBuckets = Array.from(buckets.values()).sort(
    (a, b) =>
      a.investorCode.localeCompare(b.investorCode) ||
      a.fundCode.localeCompare(b.fundCode),
  );
  for (const b of sortedBuckets) {
    totInflow += b.inflowTotal;
    totOutflow += b.outflowTotal;
    totInitial += b.initialUpfront;
    totEvery += b.perInflowUpfront;
    sumSheet.addRow({
      inv: b.investorCode,
      name: b.name,
      fund: b.fundCode,
      cat: b.category,
      sourced: b.sourcedOn.toISOString().slice(0, 10),
      n: b.txCount,
      inflow: round2(b.inflowTotal),
      outflow: round2(b.outflowTotal),
      net: round2(b.inflowTotal - b.outflowTotal),
      ub: b.unitsBought,
      us: b.unitsSold,
      initU: b.initialUpfront,
      everyU: round2(b.perInflowUpfront),
    });
  }
  // Totals row
  const totRow = sumSheet.addRow({
    inv: "TOTAL",
    name: "",
    fund: "",
    cat: "",
    sourced: "",
    n: "",
    inflow: round2(totInflow),
    outflow: round2(totOutflow),
    net: round2(totInflow - totOutflow),
    ub: "",
    us: "",
    initU: round2(totInitial),
    everyU: round2(totEvery),
  });
  totRow.font = { bold: true };
  totRow.border = { top: { style: "thin" } };

  // Header / metadata at the top of Summary — push existing rows down
  sumSheet.spliceRows(1, 0,
    [`Agent: ${agent.code} — ${agent.fullName}`],
    [`Status: ${agent.status}`],
    [`As-of date: ${asOfStr}`],
    [`Trail commission: NOT computed — public.navSnapshot table is empty in this DB. Trail requires weekly NAV snapshots per fund.`],
    [`Two upfront calculations shown for verification:`],
    [`  • Per-spec upfront (initial only) — what the cron commission engine computes today: upfront × initial sourcing gross only.`],
    [`  • Per-inflow upfront (every BUY)   — practical interpretation: every BUY (including SIP installments) earns upfront × amount.`],
    [],
  );

  // Save to disk
  const outDir = path.join(process.cwd(), "scripts", "output");
  fs.mkdirSync(outDir, { recursive: true });
  const filename = `agent-commissions-${agent.code}-${asOfStr}.xlsx`;
  const outPath = path.join(outDir, filename);
  await wb.xlsx.writeFile(outPath);
  console.log(`\n✓ Wrote ${outPath}`);
  console.log(`  • ${sortedBuckets.length} investor/fund buckets`);
  console.log(`  • Total inflow:  BDT ${totInflow.toLocaleString("en-IN", { minimumFractionDigits: 2 })}`);
  console.log(`  • Total outflow: BDT ${totOutflow.toLocaleString("en-IN", { minimumFractionDigits: 2 })}`);
  console.log(`  • Per-spec upfront (initial-only):    BDT ${totInitial.toLocaleString("en-IN", { minimumFractionDigits: 2 })}`);
  console.log(`  • Per-inflow upfront (every BUY):     BDT ${totEvery.toLocaleString("en-IN", { minimumFractionDigits: 2 })}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
