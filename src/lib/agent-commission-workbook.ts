// ExcelJS workbook builder for the per-agent commission preview.
// Consumes a PreviewResult and produces a multi-sheet workbook with
// Summary / Transactions / Trail / Terms used. Same content the script
// has been emitting, now reachable from the page via an API route.

import ExcelJS from "exceljs";
import type { PreviewResult, Term } from "@/lib/agent-commission-preview";

export async function buildAgentCommissionWorkbook(
  preview: PreviewResult,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "X-System";
  wb.created = new Date();

  buildTermsSheet(wb, preview.termsActive);
  buildTxSheet(wb, preview);
  buildTrailSheet(wb, preview);
  buildSummarySheet(wb, preview);

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

function buildTermsSheet(wb: ExcelJS.Workbook, terms: Term[]): void {
  const s = wb.addWorksheet("Terms used");
  s.columns = [
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
  s.getRow(1).font = { bold: true };
  for (const t of [...terms].sort(
    (a, b) =>
      (a.fundCategory > b.fundCategory ? 1 : -1) || +b.effectiveFrom - +a.effectiveFrom,
  )) {
    const flags: string[] = [];
    if (t.upfrontPct >= 0.01)
      flags.push(
        `upfrontPct=${t.upfrontPct} (likely percent literal — should be ${(t.upfrontPct / 100).toFixed(4)})`,
      );
    if (t.trailY1PctPa >= 0.05) flags.push(`trailY1=${t.trailY1PctPa} (>5% p.a. — check)`);
    if (t.trailY2PlusPctPa >= 0.05)
      flags.push(`trailY2+=${t.trailY2PlusPctPa} (>5% p.a. — check)`);
    s.addRow({
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
}

function buildTxSheet(wb: ExcelJS.Workbook, p: PreviewResult): void {
  const s = wb.addWorksheet("Transactions");
  s.columns = [
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
    {
      header: "Upfront commission (BDT)",
      key: "comm",
      width: 24,
      style: { numFmt: "#,##0.00" },
    },
    { header: "Notes", key: "notes", width: 40 },
  ];
  s.getRow(1).font = { bold: true };
  s.views = [{ state: "frozen", ySplit: 1 }];

  // Build a name lookup from the buckets.
  const nameByInv = new Map<string, string>();
  for (const b of p.buckets) nameByInv.set(b.investorCode, b.name);

  for (const t of p.txns) {
    const b = p.buckets.find(
      (x) => x.investorCode === t.investorCode && x.fundCode === t.fundCode,
    );
    if (!b) continue;
    const rate =
      p.termsActive.find((tm) => tm.fundCategory === b.category)?.upfrontPct ?? 0;
    const isBuy = t.direction === "BUY";
    const commission = isBuy && !b.isDirectSubscription ? t.amount * rate : 0;
    s.addRow({
      date: t.date.toISOString().slice(0, 10),
      inv: t.investorCode,
      name: nameByInv.get(t.investorCode) ?? "",
      fund: t.fundCode,
      cat: b.category,
      ch: t.channel,
      dir: t.direction,
      units: t.units,
      amount: t.amount,
      nav: t.nav ?? "",
      rate,
      comm: Math.round(commission * 100) / 100,
      notes: b.isDirectSubscription ? "Direct subscription — no commission" : "",
    });
  }
}

function buildTrailSheet(wb: ExcelJS.Workbook, p: PreviewResult): void {
  const s = wb.addWorksheet("Trail commissions");
  s.columns = [
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
    {
      header: "Avg held value (BDT)",
      key: "avgv",
      width: 22,
      style: { numFmt: "#,##0.00" },
    },
    {
      header: "Trail commission (BDT)",
      key: "trail",
      width: 24,
      style: { numFmt: "#,##0.00" },
    },
    { header: "Notes", key: "notes", width: 40 },
  ];
  s.getRow(1).font = { bold: true };
  s.views = [{ state: "frozen", ySplit: 1 }];

  if (p.trailRows.length === 0) {
    s.addRow({ notes: "No sourcings yet — no trail to compute" });
    return;
  }

  for (const r of p.trailRows) {
    s.addRow({
      inv: r.investorCode,
      fund: r.fundCode,
      qLabel: r.qLabel,
      sourced: r.sourcedOn.toISOString().slice(0, 10),
      tier: r.tier,
      rate: r.ratePa,
      qrate: r.rateQuarter,
      npts: r.navPoints,
      avgu: r.avgUnits,
      avgnav: r.avgNav,
      avgv: r.avgValue,
      trail: r.trail,
      notes: r.partial ? `Partial quarter — cut off at ${p.asOf.toISOString().slice(0, 10)}` : "",
    });
  }
}

function buildSummarySheet(wb: ExcelJS.Workbook, p: PreviewResult): void {
  const s = wb.addWorksheet("Summary");
  s.columns = [
    { header: "Investor", key: "inv", width: 10 },
    { header: "Name", key: "name", width: 28 },
    { header: "Fund", key: "fund", width: 8 },
    { header: "Category", key: "cat", width: 14 },
    { header: "Sourced on", key: "sourced", width: 12 },
    { header: "# Txns", key: "n", width: 8, style: { numFmt: "#,##0" } },
    {
      header: "Total inflow (BDT)",
      key: "inflow",
      width: 18,
      style: { numFmt: "#,##0.00" },
    },
    {
      header: "Total outflow (BDT)",
      key: "outflow",
      width: 18,
      style: { numFmt: "#,##0.00" },
    },
    {
      header: "Net inflow (BDT)",
      key: "net",
      width: 18,
      style: { numFmt: "#,##0.00" },
    },
    { header: "Units bought", key: "ub", width: 12, style: { numFmt: "#,##0.00" } },
    { header: "Units sold", key: "us", width: 12, style: { numFmt: "#,##0.00" } },
    {
      header: "Per-spec upfront (initial only)",
      key: "initU",
      width: 28,
      style: { numFmt: "#,##0.00" },
    },
    {
      header: "Per-inflow upfront (every BUY)",
      key: "everyU",
      width: 28,
      style: { numFmt: "#,##0.00" },
    },
    {
      header: "Trail commission (BDT)",
      key: "trail",
      width: 22,
      style: { numFmt: "#,##0.00" },
    },
    {
      header: "Total payable (per-inflow + trail)",
      key: "tot",
      width: 30,
      style: { numFmt: "#,##0.00" },
    },
  ];
  s.getRow(1).font = { bold: true };
  s.views = [{ state: "frozen", ySplit: 1 }];

  for (const b of p.buckets) {
    s.addRow({
      inv: b.investorCode,
      name: b.name,
      fund: b.fundCode,
      cat: b.category,
      sourced: b.sourcedOn.toISOString().slice(0, 10),
      n: b.txCount,
      inflow: Math.round(b.inflowTotal * 100) / 100,
      outflow: Math.round(b.outflowTotal * 100) / 100,
      net: Math.round((b.inflowTotal - b.outflowTotal) * 100) / 100,
      ub: b.unitsBought,
      us: b.unitsSold,
      initU: b.initialUpfront,
      everyU: Math.round(b.perInflowUpfront * 100) / 100,
      trail: Math.round(b.trailTotal * 100) / 100,
      tot: Math.round((b.perInflowUpfront + b.trailTotal) * 100) / 100,
    });
  }
  const totRow = s.addRow({
    inv: "TOTAL",
    inflow: p.totals.inflow,
    outflow: p.totals.outflow,
    net: Math.round((p.totals.inflow - p.totals.outflow) * 100) / 100,
    initU: p.totals.initialUpfront,
    everyU: p.totals.perInflowUpfront,
    trail: p.totals.trail,
    tot: p.totals.totalPayable,
  });
  totRow.font = { bold: true };
  totRow.border = { top: { style: "thin" } };

  s.spliceRows(
    1,
    0,
    [`Agent: ${p.agentCode} — ${p.agentName}`],
    [`Status: ${p.agentStatus}`],
    [`As-of date: ${p.asOf.toISOString().slice(0, 10)}`],
    [
      `Rate rule: LATEST effective term per category applied to ALL transactions (older term rows treated as superseded).`,
    ],
    [`Two upfront calculations shown for verification:`],
    [
      `  • Per-spec upfront (initial only) — what the cron commission engine computes today: upfront × initial sourcing gross only.`,
    ],
    [
      `  • Per-inflow upfront (every BUY) — practical interpretation: every BUY (including SIP installments) earns upfront × amount.`,
    ],
    [
      `Trail commission: computed from public.nav_records (daily NAV snapshots per fund). Per quarter:`,
    ],
    [`  trail = (avg of units × nav across all NAV dates in quarter) × rate p.a. ÷ 4`],
    [
      `  rate = Trail Y1 p.a. if quarter midpoint < sourced_on + 12 months, else Trail Y2+ p.a.`,
    ],
    [],
  );
}
