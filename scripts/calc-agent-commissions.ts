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

/** Look up the term for a category. The caller has already pre-filtered
 *  `terms` to just the latest one per category, so this is essentially
 *  a category match — the date check is intentionally absent so that
 *  the current canonical rates apply retroactively to every BUY in
 *  the cohort (per admin instruction). */
function termFor(terms: Term[], category: "equity" | "fixed_income"): Term | null {
  return terms.find((t) => t.fundCategory === category) ?? null;
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

  const allTerms: Term[] = agent.terms.map((t) => ({
    fundCategory: t.fundCategory as "equity" | "fixed_income",
    upfrontPct: Number(t.upfrontPct),
    trailY1PctPa: Number(t.trailY1PctPa),
    trailY2PlusPctPa: Number(t.trailY2PlusPctPa),
    clawbackMonths: t.clawbackMonths,
    clawbackPct: Number(t.clawbackPct),
    effectiveFrom: t.effectiveFrom,
    effectiveTo: t.effectiveTo,
  }));

  // Use the LATEST term per category for ALL transactions (retroactive
  // application of the current rates). This is what the admin asked for —
  // the older term rows had data-entry errors (percentages typed as
  // decimals); the most-recent rows are the canonical truth.
  const latestByCategory = new Map<"equity" | "fixed_income", Term>();
  for (const t of allTerms) {
    const cur = latestByCategory.get(t.fundCategory);
    if (!cur || t.effectiveFrom > cur.effectiveFrom) {
      latestByCategory.set(t.fundCategory, t);
    }
  }
  const terms: Term[] = Array.from(latestByCategory.values());
  console.log("Active terms (latest per category):");
  for (const t of terms) {
    console.log(
      `  ${t.fundCategory.padEnd(13)} upfront=${(t.upfrontPct * 100).toFixed(2)}%  y1=${(t.trailY1PctPa * 100).toFixed(2)}%  y2+=${(t.trailY2PlusPctPa * 100).toFixed(2)}%  clawback=${t.clawbackMonths}mo@${(t.clawbackPct * 100).toFixed(0)}%  effFrom=${t.effectiveFrom.toISOString().slice(0, 10)}`,
    );
  }

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
    trailTotal: number; // sum of quarterly trail commissions through today
    txCount: number;
    // Ordered tx history for unitsAt() during trail computation
    buys: Array<{ date: Date; units: number }>;
    sells: Array<{ date: Date; units: number }>;
  };
  const buckets = new Map<string, Bucket>();

  for (const t of txns) {
    const category = categoryForFund(t.fundCode);
    const term = termFor(terms, category);
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
        trailTotal: 0,
        txCount: 0,
        buys: [],
        sells: [],
      };
      buckets.set(key, b);
    }
    b.txCount += 1;
    if (isBuy) {
      b.inflowTotal += t.amount;
      b.unitsBought += t.units;
      b.perInflowUpfront += commission;
      b.buys.push({ date: t.date, units: t.units });
    } else {
      b.outflowTotal += t.amount;
      b.unitsSold += t.units;
      b.sells.push({ date: t.date, units: t.units });
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

  // ─── Trail commission (quarterly) ─────────────────────────────────
  // Pull all NAV snapshots for the relevant funds since the earliest
  // sourcing date. Compute per-bucket quarterly trail:
  //   weekly avg held value = mean(units_at_each_nav × nav_value)
  //   rate = trailY1 if quarter midpoint < sourcedOn + 12mo else Y2+
  //   trail = weekly avg × rate ÷ 4
  // Units at any NAV date = sum(BUYs up to that date) − sum(SELLs up
  // to that date) — naturally accounts for SIP installments expanding
  // the unit base.
  const earliestSourced = Array.from(buckets.values()).reduce<Date | null>(
    (acc, b) => (acc === null || b.sourcedOn < acc ? b.sourcedOn : acc),
    null,
  );

  type NavRow = { fundCode: FundCode; date: Date; nav: number };
  let navRows: NavRow[] = [];
  if (earliestSourced) {
    const raw = await prisma.$queryRawUnsafe<
      Array<{ fund_code: string; date: Date; nav: any }>
    >(
      `SELECT f.code AS fund_code, n.date, n.nav
       FROM public.nav_records n
       JOIN public.funds f ON f.id = n."fundId"
       WHERE n.date >= $1
       ORDER BY n.date ASC`,
      earliestSourced,
    );
    navRows = raw.map((r) => ({
      fundCode: r.fund_code as FundCode,
      date: r.date,
      nav: Number(r.nav),
    }));
  }
  const navsByFund = new Map<FundCode, NavRow[]>();
  for (const n of navRows) {
    const arr = navsByFund.get(n.fundCode) ?? [];
    arr.push(n);
    navsByFund.set(n.fundCode, arr);
  }
  console.log(`NAV records pulled: ${navRows.length} since ${earliestSourced?.toISOString().slice(0, 10) ?? "—"}`);

  // Build calendar quarters from earliest sourcing through today.
  type Q = { start: Date; end: Date; label: string };
  function calendarQuarters(from: Date, to: Date): Q[] {
    const out: Q[] = [];
    const start = new Date(Date.UTC(from.getUTCFullYear(), Math.floor(from.getUTCMonth() / 3) * 3, 1));
    let cur = start;
    while (cur <= to) {
      const next = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 3, 1));
      const end = new Date(next.getTime() - 86400_000);
      out.push({
        start: cur,
        end: end > to ? to : end,
        label: `${cur.toISOString().slice(0, 7)} Q (${cur.toISOString().slice(0, 10)} → ${(end > to ? to : end).toISOString().slice(0, 10)})`,
      });
      cur = next;
    }
    return out;
  }

  const trailSheet = wb.addWorksheet("Trail commissions");
  trailSheet.columns = [
    { header: "Investor", key: "inv", width: 10 },
    { header: "Fund", key: "fund", width: 8 },
    { header: "Quarter", key: "qLabel", width: 36 },
    { header: "Sourced on", key: "sourced", width: 12 },
    { header: "Tier", key: "tier", width: 6 },
    { header: "Rate p.a.", key: "rate", width: 12, style: { numFmt: "0.0000%" } },
    { header: "Quarterly rate", key: "qrate", width: 14, style: { numFmt: "0.0000%" } },
    { header: "# NAV pts", key: "npts", width: 10, style: { numFmt: "#,##0" } },
    { header: "Avg units held", key: "avgu", width: 14, style: { numFmt: "#,##0.00" } },
    { header: "Avg NAV", key: "avgnav", width: 12, style: { numFmt: "#,##0.0000" } },
    { header: "Avg held value (BDT)", key: "avgv", width: 22, style: { numFmt: "#,##0.00" } },
    { header: "Trail commission (BDT)", key: "trail", width: 24, style: { numFmt: "#,##0.00" } },
    { header: "Notes", key: "notes", width: 40 },
  ];
  trailSheet.getRow(1).font = { bold: true };
  trailSheet.views = [{ state: "frozen", ySplit: 1 }];

  let totTrail = 0;
  if (earliestSourced) {
    const quarters = calendarQuarters(earliestSourced, asOf);
    for (const b of Array.from(buckets.values()).sort(
      (a, b) => a.investorCode.localeCompare(b.investorCode) || a.fundCode.localeCompare(b.fundCode),
    )) {
      const term = termFor(terms, b.category as "equity" | "fixed_income");
      if (!term) continue;
      const buysSorted = [...b.buys].sort((x, y) => +x.date - +y.date);
      const sellsSorted = [...b.sells].sort((x, y) => +x.date - +y.date);
      const unitsAt = (d: Date): number => {
        let u = 0;
        for (const x of buysSorted) if (x.date <= d) u += x.units;
        for (const x of sellsSorted) if (x.date <= d) u -= x.units;
        return Math.max(0, u);
      };
      const navs = navsByFund.get(b.fundCode) ?? [];
      for (const q of quarters) {
        if (q.end < b.sourcedOn) continue; // not sourced yet in this quarter
        const qNavs = navs
          .filter((n) => n.date >= (q.start > b.sourcedOn ? q.start : b.sourcedOn) && n.date <= q.end)
          .sort((a, b) => +a.date - +b.date);
        if (qNavs.length === 0) continue;
        const midpoint = new Date((q.start.getTime() + q.end.getTime()) / 2);
        const isY1 = midpoint < addMonths(b.sourcedOn, 12);
        const ratePa = isY1 ? term.trailY1PctPa : term.trailY2PlusPctPa;
        const rateQuarter = ratePa / 4;
        const values = qNavs.map((n) => ({ u: unitsAt(n.date), v: n.nav, val: unitsAt(n.date) * n.nav }));
        const avgValue = values.reduce((s, x) => s + x.val, 0) / values.length;
        const avgUnits = values.reduce((s, x) => s + x.u, 0) / values.length;
        const avgNav = values.reduce((s, x) => s + x.v, 0) / values.length;
        const trail = round2(avgValue * rateQuarter);
        if (avgValue <= 0) continue;
        totTrail += trail;
        b.trailTotal += trail;
        trailSheet.addRow({
          inv: b.investorCode,
          fund: b.fundCode,
          qLabel: q.label,
          sourced: b.sourcedOn.toISOString().slice(0, 10),
          tier: isY1 ? "Y1" : "Y2+",
          rate: ratePa,
          qrate: rateQuarter,
          npts: values.length,
          avgu: avgUnits,
          avgnav: avgNav,
          avgv: avgValue,
          trail,
          notes:
            q.end >= asOf
              ? `Partial quarter — cut off at today (${asOf.toISOString().slice(0, 10)})`
              : "",
        });
      }
    }
  } else {
    trailSheet.addRow({ notes: "No sourcings yet — no trail to compute" });
  }
  console.log(`Total trail (across all quarters): BDT ${totTrail.toLocaleString("en-IN", { minimumFractionDigits: 2 })}`);

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
    { header: "Trail commission (BDT)", key: "trail", width: 22, style: { numFmt: "#,##0.00" } },
    { header: "Total payable (per-inflow + trail)", key: "tot", width: 30, style: { numFmt: "#,##0.00" } },
  ];
  sumSheet.getRow(1).font = { bold: true };
  sumSheet.views = [{ state: "frozen", ySplit: 1 }];

  let totInflow = 0,
    totOutflow = 0,
    totInitial = 0,
    totEvery = 0,
    totTrailSum = 0;
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
    totTrailSum += b.trailTotal;
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
      trail: round2(b.trailTotal),
      tot: round2(b.perInflowUpfront + b.trailTotal),
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
    trail: round2(totTrailSum),
    tot: round2(totEvery + totTrailSum),
  });
  totRow.font = { bold: true };
  totRow.border = { top: { style: "thin" } };

  // Header / metadata at the top of Summary — push existing rows down
  sumSheet.spliceRows(1, 0,
    [`Agent: ${agent.code} — ${agent.fullName}`],
    [`Status: ${agent.status}`],
    [`As-of date: ${asOfStr}`],
    [`Rate rule: LATEST effective term per category applied to ALL transactions (older term rows treated as superseded).`],
    [`Two upfront calculations shown for verification:`],
    [`  • Per-spec upfront (initial only) — what the cron commission engine computes today: upfront × initial sourcing gross only.`],
    [`  • Per-inflow upfront (every BUY)   — practical interpretation: every BUY (including SIP installments) earns upfront × amount.`],
    [`Trail commission: computed from public.nav_records (daily NAV snapshots per fund). Per quarter:`],
    [`  trail = (avg of units × nav across all NAV dates in the quarter) × rate p.a. ÷ 4`],
    [`  rate = Trail Y1 p.a. if quarter midpoint < sourced_on + 12 months, else Trail Y2+ p.a.`],
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
  console.log(`  • Trail commission (quarterly sum):   BDT ${totTrailSum.toLocaleString("en-IN", { minimumFractionDigits: 2 })}`);
  console.log(`  • Total payable (every-BUY + trail):  BDT ${(totEvery + totTrailSum).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
