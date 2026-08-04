// ExcelJS workbook builder for the per-agent commission preview.
// Consumes a PreviewResult and produces a multi-sheet workbook with
// Summary / Transactions / Trail / Terms used. Same content the script
// has been emitting, now reachable from the page via an API route.

import ExcelJS from "exceljs";
import type { PreviewResult, Term } from "@/lib/agent-commission-preview";

/**
 * Who the file is for. The agent variant drops internal detail: the Terms
 * sheet's data-quality `Flag` column (which says things like "likely percent
 * literal — should be 0.0050", i.e. our own rates may be misconfigured), and
 * the Summary header's references to internal table names.
 */
export type CommissionAudience = "admin" | "agent";

export async function buildAgentCommissionWorkbook(
  preview: PreviewResult,
  opts: { audience?: CommissionAudience } = {},
): Promise<Buffer> {
  const audience = opts.audience ?? "admin";
  const wb = new ExcelJS.Workbook();
  wb.creator = "X-System";
  wb.created = new Date();

  buildTermsSheet(wb, preview.termsActive, audience);
  buildTxSheet(wb, preview);
  buildWatermarkSheet(wb, preview, audience);
  buildTrailSheet(wb, preview);
  buildSummarySheet(wb, preview, audience);

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

function buildTermsSheet(
  wb: ExcelJS.Workbook,
  terms: Term[],
  audience: CommissionAudience,
): void {
  const isAdmin = audience === "admin";
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
    // Internal data-quality warnings — admin only.
    ...(isAdmin ? [{ header: "Flag", key: "flag", width: 50 }] : []),
  ];
  s.getRow(1).font = { bold: true };
  for (const t of [...terms].sort(
    (a, b) =>
      (a.fundCategory > b.fundCategory ? 1 : -1) || +b.effectiveFrom - +a.effectiveFrom,
  )) {
    const flags: string[] = [];
    if (isAdmin) {
      if (t.upfrontPct >= 0.01)
        flags.push(
          `upfrontPct=${t.upfrontPct} (likely percent literal — should be ${(t.upfrontPct / 100).toFixed(4)})`,
        );
      if (t.trailY1PctPa >= 0.05) flags.push(`trailY1=${t.trailY1PctPa} (>5% p.a. — check)`);
      if (t.trailY2PlusPctPa >= 0.05)
        flags.push(`trailY2+=${t.trailY2PlusPctPa} (>5% p.a. — check)`);
    }
    s.addRow({
      cat: t.fundCategory,
      from: t.effectiveFrom.toISOString().slice(0, 10),
      to: t.effectiveTo ? t.effectiveTo.toISOString().slice(0, 10) : "—",
      up: t.upfrontPct,
      y1: t.trailY1PctPa,
      y2: t.trailY2PlusPctPa,
      cm: t.clawbackMonths,
      cp: t.clawbackPct,
      ...(isAdmin ? { flag: flags.join("; ") } : {}),
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
    // The term's upfront rate is kept as documentation of what was in force on
    // the day. The "Upfront commission" column that used to sit beside it —
    // Amount × Upfront %, per BUY — was removed: nobody is paid on that basis.
    // Upfront is a high-water-mark on the agent's whole book, so a per-BUY
    // figure here only invited the reader to add up a column that is not owed.
    // See the "Upfront watermark" sheet for what actually accrues.
    { header: "Upfront %", key: "rate", width: 12, style: { numFmt: "0.0000%" } },
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
      notes: b.isDirectSubscription
        ? "Direct subscription — no commission"
        : !isBuy
          ? "Redemption — no upfront"
          : "",
    });
  }
}

/**
 * The upfront watermark, replayed movement by movement — ONE block for the
 * agent's whole book, in the order the engine actually processed it. Every
 * investor's movements interleave in a single series, which is why each row
 * names its investor.
 *
 * This is the same shape the AMC's own reconciliation workbook uses.
 *
 * Every figure past the opening row is a LIVE FORMULA, so an agent can click
 * any cell and see the rule rather than take the total on faith:
 *
 *   Net principal   F = F(prev) + E          running Σ BUY − SELL, whole book
 *   Watermark       G = MAX(G(prev), F)      the peak; never falls
 *   New money       H = MAX(0, G − G(prev))  only what rose above the peak
 *   Upfront         J = H × I
 *
 * The opening row seeds G with the watermark already commissioned, so money
 * that merely refills below it visibly earns nothing. That chain reproduces
 * the engine exactly — including a redemption by one client cancelling a
 * subscription by another, which is the whole point of the model and is
 * visible here as the net principal simply not making a new high.
 *
 * The preamble is written BEFORE any data, unlike the other sheets which
 * splice theirs in at the end: spliceRows does not rewrite formula strings, so
 * inserting rows above a live chain would silently point every cell one row
 * off.
 */
function buildWatermarkSheet(
  wb: ExcelJS.Workbook,
  p: PreviewResult,
  audience: CommissionAudience,
): void {
  const s = wb.addWorksheet("Upfront watermark");
  const money = "#,##0.00";
  // No `header` on the columns: the header row is added by hand below the
  // preamble, so the data starts at a row number we control.
  s.columns = [
    { key: "date", width: 12 },
    { key: "inv", width: 26 },
    { key: "fund", width: 8 },
    { key: "dir", width: 12 },
    { key: "delta", width: 16, style: { numFmt: money } },
    { key: "net", width: 20, style: { numFmt: money } },
    { key: "peak", width: 18, style: { numFmt: money } },
    { key: "new", width: 16, style: { numFmt: money } },
    { key: "rate", width: 12, style: { numFmt: "0.0000%" } },
    { key: "up", width: 16, style: { numFmt: money } },
    { key: "why", width: 56 },
  ];

  const notes: string[] =
    audience === "admin"
      ? [
          `Upfront watermark replay — the agent's WHOLE BOOK as one series: every investor sourced, all funds, in engine order (SELL before BUY within a date).`,
          `Net principal F = F(prev) + E · Watermark G = MAX(G(prev), F) · New money H = MAX(0, G − G(prev)) · Upfront J = H × I.`,
          `CIP rows are synthetic offsetting SELLs — reinvested dividend is not new money and does not lift the watermark.`,
          `Row order is the replay order, not the transaction id order. Redemptions are subtracted on magnitude (see principalDelta).`,
          `Book-level since 2026-08: money moved between two of this agent's own investors nets to nothing and earns no upfront.`,
        ]
      : [
          `How your upfront is worked out, one movement at a time.`,
          `Upfront is paid on new money only — the amount by which the total principal you have brought in rises above its previous peak, counting every investor and all three funds together.`,
          `The peak never falls when a client redeems, so money that leaves and comes back does not earn upfront twice. Moving money between two of your own investors is not new money either. Dividends reinvested under CIP are not new money.`,
          `Every figure here is a live formula — click any cell to see the calculation behind it.`,
        ];
  for (const line of notes) s.addRow({ date: line });
  s.addRow({});

  const headerRow = s.addRow({
    date: "Date",
    inv: "Investor",
    fund: "Fund",
    dir: "Movement",
    delta: "Amount (BDT)",
    net: "Net principal after",
    peak: "Watermark (peak)",
    new: "New money",
    rate: "Upfront %",
    up: "Upfront (BDT)",
    why: "Why",
  });
  headerRow.font = { bold: true };
  s.views = [{ state: "frozen", ySplit: headerRow.number }];

  const w = p.upfrontWatermark;
  if (!w) {
    s.addRow({ why: "No sourced investors yet — no upfront to compute" });
    return;
  }

  const nameByCode = new Map(w.legs.map((l) => [l.investorCode, l.investorName]));
  const openingLabel =
    audience === "agent" ? "Opening — already commissioned" : "Opening — stored watermark";

  // Seed row: net principal starts at zero, the peak starts at whatever has
  // already been paid for. Every formula below chains off these two cells.
  const open = s.addRow({ net: 0, peak: w.storedWatermark, why: openingLabel });
  open.font = { italic: true };
  const openRow = open.number;

  const firstRow = openRow + 1;
  for (const step of w.trace) {
    const name = nameByCode.get(step.investorCode);
    const row = s.addRow({
      date: step.date.toISOString().slice(0, 10),
      inv: name ? `${step.investorCode} ${name}` : step.investorCode,
      fund: step.fundCode,
      dir: step.source === "cip" ? "CIP" : step.direction,
      delta: step.delta,
      rate: step.rate,
      why: step.note,
    });
    const n = row.number;
    row.getCell("net").value = { formula: `F${n - 1}+E${n}`, result: step.running };
    row.getCell("peak").value = { formula: `MAX(G${n - 1},F${n})`, result: step.peak };
    row.getCell("new").value = { formula: `MAX(0,G${n}-G${n - 1})`, result: step.newMoney };
    row.getCell("up").value = { formula: `H${n}*I${n}`, result: step.upfront };
  }

  const lastRow = openRow + w.trace.length;
  const tot = s.addRow({ why: "Pending upfront — whole book" });
  tot.font = { bold: true };
  tot.border = { top: { style: "thin" } };
  if (w.trace.length > 0) {
    tot.getCell("new").value = { formula: `SUM(H${firstRow}:H${lastRow})`, result: w.pendingIncrement };
    tot.getCell("up").value = { formula: `SUM(J${firstRow}:J${lastRow})`, result: w.pendingUpfront };
  } else {
    tot.getCell("new").value = 0;
    tot.getCell("up").value = 0;
  }

  if (w.unratedFunds.length > 0) {
    const flag = s.addRow({
      why: `Blocked: no commission term covers ${w.unratedFunds.join(", ")} — nothing posts for this agent until that is set up`,
    });
    flag.font = { bold: true };
  }

  // Who the pending upfront is billed to. The replay above is one series, so
  // this is the only place the split by investor is visible.
  if (w.legs.some((l) => l.attributedUpfront > 0)) {
    s.addRow({});
    const legHead = s.addRow({ date: "BILLED TO", inv: "Investor", fund: "Fund", new: "New money", rate: "Rate", up: "Upfront" });
    legHead.font = { bold: true };
    for (const leg of w.legs) {
      if (leg.attributedUpfront <= 0) continue;
      s.addRow({
        inv: leg.investorName ? `${leg.investorCode} ${leg.investorName}` : leg.investorCode,
        fund: leg.fundCode,
        new: leg.attributedIncrement,
        rate: leg.upfrontPct,
        up: leg.attributedUpfront,
      });
    }
  }

  if (!p.upfrontEntitled) {
    const susp = s.addRow({
      why: `Upfront is suspended from ${p.upfrontSuspendedFrom ?? "—"} — the amounts above are not payable while suspended.`,
    });
    susp.font = { bold: true };
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
    const row = s.addRow({
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
      notes: r.partial ? `Partial quarter — cut off at ${p.asOf.toISOString().slice(0, 10)}` : "",
    });

    // Trail commission (column L) is a LIVE FORMULA, like the upfront column on
    // the Transactions sheet: an agent can click it and see
    // = Avg held value × period rate (K × G) in the formula bar.
    //
    // Only L is a formula. "Avg held value" (K) is deliberately left as the
    // engine's own figure and NOT `=I*J`, because it is the average of
    // (units × NAV) across each NAV date — which is not the same as
    // (average units) × (average NAV) once units change mid-period. Writing
    // K as a formula would silently disagree with what is actually paid.
    // G = period rate, K = avg held value, L = this column.
    const n = row.number;
    row.getCell("trail").value = { formula: `K${n}*G${n}`, result: r.trail };
  }
}

function buildSummarySheet(
  wb: ExcelJS.Workbook,
  p: PreviewResult,
  audience: CommissionAudience,
): void {
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
    { header: "Units bought", key: "ub", width: 16, style: { numFmt: "#,##0.00" } },
    { header: "Units sold", key: "us", width: 16, style: { numFmt: "#,##0.00" } },
    // Upfront is the WATERMARK's own per-(investor, fund) attribution — the
    // same figure the UPFRONT WATERMARK block below bills, and the same one the
    // runner posts. Two earlier columns here billed on other bases and had to
    // go: "Per-inflow upfront (every BUY)" and "Per-spec upfront (initial
    // only)". The latter charged for an investor whose money arrived while the
    // book was below its peak — it replaced money that had left, so it set no
    // new high and earns nothing.
    {
      header: "Upfront payable (BDT)",
      key: "upfront",
      width: 22,
      style: { numFmt: "#,##0.00" },
    },
    {
      header: "Trail payable (BDT)",
      key: "trail",
      width: 22,
      style: { numFmt: "#,##0.00" },
    },
  ];
  // Attribution by (investor, fund), zeroed when upfront is suspended so the
  // column still sums to totals.pendingUpfront.
  const upfrontByLeg = new Map(
    (p.upfrontWatermark?.legs ?? []).map((l) => [
      `${l.investorCode}|${l.fundCode}`,
      p.upfrontEntitled ? l.attributedUpfront : 0,
    ]),
  );
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
      upfront: upfrontByLeg.get(`${b.investorCode}|${b.fundCode}`) ?? 0,
      trail: Math.round(b.trailTotal * 100) / 100,
    });
  }
  const totRow = s.addRow({
    inv: "TOTAL",
    inflow: p.totals.inflow,
    outflow: p.totals.outflow,
    net: Math.round((p.totals.inflow - p.totals.outflow) * 100) / 100,
    upfront: p.totals.pendingUpfront,
    trail: p.totals.trail,
  });
  totRow.font = { bold: true };
  totRow.border = { top: { style: "thin" } };

  // Watermark upfront summary (the live upfront model) — ONE book-level row,
  // with the investor × fund attribution beneath it.
  const peakLabel = audience === "agent" ? "Peak" : "Watermark (peak)";
  const wm = p.upfrontWatermark;
  if (wm) {
    s.addRow({});
    const wmHead = s.addRow({ inv: "UPFRONT WATERMARK (whole book — every investor, all funds combined)" });
    wmHead.font = { bold: true };
    // These rows borrow the sheet's columns for their own layout: `ub` carries
    // new money, `us` the rate, and upfront amounts land in the `upfront`
    // column itself — so the per-leg figures below sit directly under the same
    // per-investor column they populate above, and the two must agree. Each
    // block prints its own header row, so the borrowed columns are labelled.
    s.addRow({ inv: "Book", name: "Investors", inflow: "Net principal now", net: peakLabel, us: "Rate", ub: "Pending new money", upfront: "Pending upfront" });
    const wmRow = s.addRow({
      inv: p.agentCode,
      name: new Set(wm.legs.map((l) => l.investorCode)).size,
      inflow: Math.round(wm.currentNetPrincipal * 100) / 100,
      net: Math.round(Math.max(wm.storedWatermark, wm.peak) * 100) / 100,
      us: wm.mixedRate ? `${(wm.blendedPct * 100).toFixed(4)}% blended` : `${(wm.blendedPct * 100).toFixed(4)}%`,
      ub: Math.round(wm.pendingIncrement * 100) / 100,
      upfront: Math.round(p.totals.pendingUpfront * 100) / 100,
    });
    wmRow.font = { bold: true };

    // Attribution — the audit trail for which investor and fund earned what.
    // This is the SAME number the per-investor rows above carry; it is repeated
    // here with the new money and rate that produced it.
    s.addRow({});
    const legHead = s.addRow({ inv: "UPFRONT WATERMARK — by investor × fund" });
    legHead.font = { bold: true };
    s.addRow({ inv: "Investor", name: "Fund", cat: "Category", inflow: "Net principal", ub: "New money", us: "Rate", upfront: "Upfront" });
    for (const leg of wm.legs) {
      s.addRow({
        inv: leg.investorName ? `${leg.investorCode} ${leg.investorName}` : leg.investorCode,
        name: leg.fundCode,
        cat: leg.category,
        inflow: Math.round(leg.netPrincipal * 100) / 100,
        ub: Math.round(leg.attributedIncrement * 100) / 100,
        us: `${(leg.upfrontPct * 100).toFixed(4)}%`,
        upfront: Math.round(leg.attributedUpfront * 100) / 100,
      });
    }
  }

  const header: string[][] =
    audience === "admin"
      ? [
          [`Agent: ${p.agentCode} — ${p.agentName}`],
          [`Status: ${p.agentStatus}`],
          [`As-of date: ${p.asOf.toISOString().slice(0, 10)}`],
          [
            `Rate rule — TRAIL: latest effective term per category applied to all periods (older term rows treated as superseded).`,
          ],
          [
            `Rate rule — UPFRONT: the term in force ON the as-of date above. This is the same resolver the posting run uses, so the rate quoted here is the rate that gets posted.`,
          ],
          [`Upfront commission: per-agent BOOK HIGH-WATER-MARK — every investor sourced, all funds, one series (see the Upfront Watermark block below).`],
          [
            `  • watermark = running peak of the agent's whole book of net invested principal (Σ BUY−SELL cash, every investor and fund combined); it never falls when a client redeems or switches funds.`,
          ],
          [
            `  • money moved between two of this agent's own investors nets to nothing — book-level since 2026-08, so cross-account churn cannot manufacture a new high.`,
          ],
          [
            `  • CIP dividend reinvestment is EXCLUDED — a reinvested dividend is not new money and does not lift the watermark.`,
          ],
          [
            `  • upfront = max(0, new peak − stored watermark) × the upfront % of the fund that received the money setting the new high; a split increment is pro-rated across funds at each fund's own rate.`,
          ],
          [
            `Summary sheet: "Upfront payable" is the watermark's own per-investor × fund attribution — identical to the UPFRONT WATERMARK block below, and to what the run posts. A row reads 0.00 where that investor's money replaced money that had left, setting no new high. Rows sum to their TOTAL; total payable = upfront + trail.`,
          ],
          [
            `Trail commission: computed from public.nav_records (daily NAV snapshots per fund). Per period (monthly or quarterly, per the term's Trail frequency):`,
          ],
          [`  trail = (avg of units × nav across all NAV dates in period) × rate p.a. ÷ periods_per_year (12 monthly, 4 quarterly)`],
          [
            `  rate = Trail Y1 p.a. if period midpoint < sourced_on + 12 months, else Trail Y2+ p.a.`,
          ],
          [],
        ]
      : [
          [`Agent: ${p.agentCode} — ${p.agentName}`],
          [`As-of date: ${p.asOf.toISOString().slice(0, 10)}`],
          [`Commission terms currently in force are applied to all periods.`],
          [`Upfront: paid on new money only — on the amount by which the total principal you have brought in rises above its previous peak, counting every investor and all three funds together.`],
          [`  • Redemptions do not lower that peak. Moving money between funds, or between two of your own investors, is not new money — so the same money never earns upfront twice.`],
          [`  • Dividends reinvested under CIP are not counted as new money. The rate applied is that of the fund the new money went into.`],
          [`  • Summary sheet, "Upfront payable": your upfront split across the investors and funds that actually pushed the book above its previous peak. A row reads 0.00 where that money replaced money that had left — it set no new high, so no upfront is due on it. The same figures appear in the UPFRONT WATERMARK block, movement by movement.`],
          [`Trail: accrues each period on the average value of units held, at the rate per annum for the applicable year band, and is paid after the period closes.`],
          [`  • Rows marked partial are still accruing and have not been posted.`],
          [`This is an as-of-today estimate for your information, not a statement of account. The amount payable is confirmed when the office posts the run.`],
          [],
        ];

  s.spliceRows(1, 0, ...header);
}
