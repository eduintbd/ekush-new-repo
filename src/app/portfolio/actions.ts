"use server";

// FVTPL revaluation under FVOCI treatment (BD IFRS 9, AMC own books).
//
// What this action posts:
//
//   For each priced holding with a non-zero DELTA vs the cumulative
//   unrealised gain already recorded for that instrument in prior
//   FairValueAdjustment rows:
//
//     gain  → dr <Instrument.investmentAccount>  delta   (instrumentCode tag)
//     loss  → cr <Instrument.investmentAccount>  |delta| (instrumentCode tag)
//
//   Then one offsetting Fair Value Reserve line balances the voucher:
//     net dr  → cr Fair Value Reserve  net
//     net cr  → dr Fair Value Reserve  net
//
// Marginal basis: every revaluation posts the DELTA between current
// per-instrument cumulative unrealised and what was already booked
// across all prior active FVAs in the same fiscal year. Fair Value
// Reserve credit balance therefore equals the cumulative unrealised
// gain across all priced holdings at any time.
//
// Idempotency:
//   - Re-running for the same asOfDate first reverses the active FVA
//     for that same date (mirroring its per-instrument lines exactly),
//     then computes the fresh delta against the OTHER active FVAs and
//     posts a new voucher.
//   - Retroactive Price entries don't poison the books because each
//     FVA's per-instrument cumulative is SNAPSHOT in
//     FairValueAdjustmentLine at post-time.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { prisma, withActor } from "@/lib/prisma";
import { requireRole, canEdit } from "@/lib/auth";
import { allocateVoucherNo } from "@/lib/voucher";
import { buildPortfolioAsOf, fromPrismaTrades, latestPricesMap } from "@/lib/portfolio";

const FAIR_VALUE_RESERVE = "Fair Value Reserve";
const PORTFOLIO_PATH = "/portfolio";

const Schema = z.object({
  asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "as-of date required"),
  fiscalYearId: z.string().min(1, "fiscal year required"),
});

function back(qs: string, msg: string): never {
  redirect(`${PORTFOLIO_PATH}?${qs}&error=${encodeURIComponent(msg)}`);
}

export async function revalueToMarket(formData: FormData): Promise<void> {
  const profile = await requireRole(["admin", "accountant"]);
  if (!canEdit(profile)) redirect(`${PORTFOLIO_PATH}?error=Insufficient+role`);

  const parsed = Schema.safeParse({
    asOfDate: String(formData.get("asOfDate") ?? ""),
    fiscalYearId: String(formData.get("fiscalYearId") ?? ""),
  });
  if (!parsed.success) {
    redirect(`${PORTFOLIO_PATH}?error=${encodeURIComponent(parsed.error.issues[0]?.message ?? "invalid")}`);
  }
  const data = parsed.data;
  const baseQs = `asOf=${data.asOfDate}&fy=${data.fiscalYearId}`;

  const fy = await prisma.fiscalYear.findUnique({ where: { id: data.fiscalYearId } });
  if (!fy) back(baseQs, "Fiscal year not found");
  if (fy.isClosed) back(baseQs, "Fiscal year is closed");
  const asOf = new Date(`${data.asOfDate}T00:00:00Z`);
  if (asOf < fy.startsOn || asOf > fy.endsOn) {
    back(baseQs, "As-of date is outside the selected fiscal year");
  }

  // Defensive — Fair Value Reserve must exist in CoA.
  const fvr = await prisma.chartOfAccount.findUnique({ where: { name: FAIR_VALUE_RESERVE } });
  if (!fvr) back(baseQs, `Missing CoA target — need "${FAIR_VALUE_RESERVE}"`);

  // Build current portfolio: trades + latest price per instrument.
  const tradeRows = await prisma.trade.findMany({
    where: { tradeDate: { lte: asOf } },
    orderBy: [{ tradeDate: "asc" }, { createdAt: "asc" }],
  });
  const priceRows = await prisma.price.findMany({
    where: { priceDate: { lte: asOf } },
  });
  const portfolio = buildPortfolioAsOf(fromPrismaTrades(tradeRows), latestPricesMap(priceRows), asOf);
  const priced = portfolio.filter((r) => r.unrealisedPnl !== null && r.marketValue !== null);
  if (priced.length === 0) {
    back(baseQs, "No priced holdings on or before this date — enter prices first");
  }
  const missing = portfolio.filter((r) => r.unrealisedPnl === null);
  if (missing.length > 0) {
    back(
      baseQs,
      `Missing price on or before ${data.asOfDate} for: ${missing.map((m) => m.instrumentCode).join(", ")}`,
    );
  }

  // Look up each held instrument's investmentAccount.
  const codes = priced.map((r) => r.instrumentCode);
  const instruments = await prisma.instrument.findMany({ where: { code: { in: codes } } });
  const invAccountByCode = new Map(instruments.map((i) => [i.code, i.investmentAccount]));
  for (const code of codes) {
    if (!invAccountByCode.has(code)) {
      back(baseQs, `Instrument ${code} not in master — seed it before revaluation`);
    }
  }

  // Verify every investmentAccount exists in CoA.
  const invAccs = [...new Set([...invAccountByCode.values()])];
  const invAccRows = await prisma.chartOfAccount.findMany({
    where: { name: { in: invAccs } },
    select: { name: true },
  });
  const invAccSet = new Set(invAccRows.map((a) => a.name));
  for (const acc of invAccs) {
    if (!invAccSet.has(acc)) back(baseQs, `Investment account "${acc}" missing from CoA`);
  }

  const totalCost = round2(priced.reduce((s, r) => s + r.totalCost, 0));
  const totalMarket = round2(priced.reduce((s, r) => s + (r.marketValue ?? 0), 0));
  const cumulativeUnrealised = round2(totalMarket - totalCost);

  const txResult = await withActor(profile.id, async (tx) => {
    // Step 0: garbage-collect orphan FVAs. If an admin manually deleted
    // an FV voucher from /day-book (only touches the Journal table, not
    // FairValueAdjustment), the snapshot is left dangling and would
    // poison Step 2's baseline — `cumulativeUnrealisedPnl` from a
    // snapshot whose journal entries no longer exist makes every later
    // Revalue compute `delta ≈ 0` and post nothing. Detect FVAs in
    // this FY whose journalBatchId has zero Journal rows and silently
    // mark them reversedAt. Only scoped to the current FY because
    // closed prior years can't have their journals deleted by users.
    const activeFvasThisFy = await tx.fairValueAdjustment.findMany({
      where: { fiscalYearId: data.fiscalYearId, reversedAt: null },
      select: { id: true, journalBatchId: true },
    });
    if (activeFvasThisFy.length > 0) {
      const batchIds = activeFvasThisFy.map((f) => f.journalBatchId);
      const counts = await tx.journal.groupBy({
        by: ["batchId"],
        where: { batchId: { in: batchIds } },
        _count: { batchId: true },
      });
      const countByBatch = new Map(counts.map((c) => [c.batchId, c._count.batchId]));
      const orphanIds = activeFvasThisFy
        .filter((f) => (countByBatch.get(f.journalBatchId) ?? 0) === 0)
        .map((f) => f.id);
      if (orphanIds.length > 0) {
        await tx.fairValueAdjustment.updateMany({
          where: { id: { in: orphanIds } },
          data: { reversedAt: new Date() },
        });
      }
    }

    // Step 1: if a same-date FVA exists, reverse it first.
    const sameDateActive = await tx.fairValueAdjustment.findFirst({
      where: { fiscalYearId: data.fiscalYearId, asOfDate: asOf, reversedAt: null },
      include: { lines: true },
    });
    if (sameDateActive) {
      const reversalBatch = randomUUID();
      const reversalVoucher = await allocateVoucherNo(tx, data.fiscalYearId, fy.label, "FV");
      // Mirror every line with sign-flipped deltaPosted.
      const reversalLines: Array<{
        entryDate: Date;
        description: string;
        txnType: string;
        voucherNo: string;
        accountName: string;
        debit: number;
        credit: number;
        fiscalYearId: string;
        batchId: string;
        instrumentCode: string | null;
        createdBy: string | null;
      }> = [];
      let netReversal = 0;
      for (const line of sameDateActive.lines) {
        const delta = Number(line.deltaPosted);
        if (Math.abs(delta) < 0.005) continue;
        const invAcc = invAccountByCode.get(line.instrumentCode);
        if (!invAcc) continue; // instrument removed since post — skip
        const desc = `FVTPL reversal ${data.asOfDate} — ${line.instrumentCode}`;
        reversalLines.push({
          entryDate: asOf,
          description: desc,
          txnType: "FV",
          voucherNo: reversalVoucher,
          accountName: invAcc,
          debit: delta > 0 ? 0 : Math.abs(delta),
          credit: delta > 0 ? Math.abs(delta) : 0,
          fiscalYearId: data.fiscalYearId,
          batchId: reversalBatch,
          instrumentCode: line.instrumentCode,
          createdBy: profile.id,
        });
        netReversal += delta;
      }
      netReversal = round2(netReversal);
      if (Math.abs(netReversal) >= 0.005) {
        reversalLines.push({
          entryDate: asOf,
          description: `FVTPL reversal ${data.asOfDate}`,
          txnType: "FV",
          voucherNo: reversalVoucher,
          accountName: FAIR_VALUE_RESERVE,
          debit: netReversal > 0 ? Math.abs(netReversal) : 0,
          credit: netReversal > 0 ? 0 : Math.abs(netReversal),
          fiscalYearId: data.fiscalYearId,
          batchId: reversalBatch,
          instrumentCode: null,
          createdBy: profile.id,
        });
      }
      if (reversalLines.length > 0) {
        await tx.journal.createMany({ data: reversalLines });
      }
      await tx.fairValueAdjustment.update({
        where: { id: sameDateActive.id },
        data: { reversedAt: new Date() },
      });
    }

    // Step 2: build per-instrument baseline = the LATEST active FVA's
    // cumulativeUnrealisedPnl snapshot per instrument, ACROSS ALL FYs.
    // Prior-FY snapshots are still valid baselines because the opening
    // balance on Fair Value Reserve carries the prior FY's cumulative
    // — without consulting them, the first revaluation of a new FY
    // treats baseline as 0 and re-credits the full cumulative UG,
    // double-counting the OB on equity.
    const priorActive = await tx.fairValueAdjustment.findMany({
      where: { reversedAt: null },
      include: { lines: true },
      orderBy: { asOfDate: "asc" },
    });
    const baselineByCode = new Map<string, number>();
    for (const fva of priorActive) {
      for (const line of fva.lines) {
        baselineByCode.set(line.instrumentCode, Number(line.cumulativeUnrealisedPnl));
      }
    }

    // Step 3: compute per-instrument delta vs baseline.
    const deltaByCode = new Map<string, number>();
    for (const r of priced) {
      const baseline = baselineByCode.get(r.instrumentCode) ?? 0;
      const delta = round2((r.unrealisedPnl ?? 0) - baseline);
      deltaByCode.set(r.instrumentCode, delta);
    }
    // Also handle instruments that USED to have a baseline but are no
    // longer held (fully sold since prior FVA). Their cumulative needs
    // to be removed — but only if they have no current row in `priced`.
    for (const [code, baseline] of baselineByCode) {
      if (!deltaByCode.has(code) && Math.abs(baseline) >= 0.005) {
        // Mark down to zero — delta = 0 - baseline = -baseline.
        deltaByCode.set(code, round2(-baseline));
      }
    }

    // Step 4: build new journal lines.
    const newBatchId = randomUUID();
    const newVoucherNo = await allocateVoucherNo(tx, data.fiscalYearId, fy.label, "FV");
    const newLines: Array<{
      entryDate: Date;
      description: string;
      txnType: string;
      voucherNo: string;
      accountName: string;
      debit: number;
      credit: number;
      fiscalYearId: string;
      batchId: string;
      instrumentCode: string | null;
      createdBy: string | null;
    }> = [];
    let netDelta = 0;
    for (const [code, delta] of deltaByCode) {
      if (Math.abs(delta) < 0.005) continue;
      const invAcc = invAccountByCode.get(code);
      if (!invAcc) continue;
      newLines.push({
        entryDate: asOf,
        description: `FVTPL ${data.asOfDate} — ${code}`,
        txnType: "FV",
        voucherNo: newVoucherNo,
        accountName: invAcc,
        debit: delta > 0 ? delta : 0,
        credit: delta > 0 ? 0 : Math.abs(delta),
        fiscalYearId: data.fiscalYearId,
        batchId: newBatchId,
        instrumentCode: code,
        createdBy: profile.id,
      });
      netDelta += delta;
    }
    netDelta = round2(netDelta);
    if (Math.abs(netDelta) >= 0.005) {
      newLines.push({
        entryDate: asOf,
        description: `FVTPL revaluation as of ${data.asOfDate}`,
        txnType: "FV",
        voucherNo: newVoucherNo,
        accountName: FAIR_VALUE_RESERVE,
        debit: netDelta > 0 ? 0 : Math.abs(netDelta),
        credit: netDelta > 0 ? netDelta : 0,
        fiscalYearId: data.fiscalYearId,
        batchId: newBatchId,
        instrumentCode: null,
        createdBy: profile.id,
      });
    }

    // Step 5: insert the new FairValueAdjustment + snapshot lines + journal.
    if (newLines.length === 0) {
      // No delta to post — short-circuit. (E.g. same-date rerun with
      // no price changes after the reversal; or unchanged book.)
      // We still want to record an FVA row to preserve idempotency,
      // but skip the journal write.
    } else {
      await tx.journal.createMany({ data: newLines });
    }

    const fva = await tx.fairValueAdjustment.create({
      data: {
        asOfDate: asOf,
        fiscalYearId: data.fiscalYearId,
        journalBatchId: newBatchId,
        totalCost,
        totalMarket,
        unrealisedPnl: cumulativeUnrealised,
        createdBy: profile.id,
      },
    });

    if (priced.length > 0) {
      await tx.fairValueAdjustmentLine.createMany({
        data: priced.map((r) => ({
          adjustmentId: fva.id,
          instrumentCode: r.instrumentCode,
          quantity: r.quantity,
          totalCost: round2(r.totalCost),
          marketRate: r.marketRate ?? 0,
          marketValue: round2(r.marketValue ?? 0),
          cumulativeUnrealisedPnl: round2(r.unrealisedPnl ?? 0),
          deltaPosted: deltaByCode.get(r.instrumentCode) ?? 0,
        })),
      });
    }

    return { voucherNo: newVoucherNo, netDelta };
  });

  revalidatePath("/portfolio");
  revalidatePath("/journals");
  revalidatePath("/day-book");
  revalidatePath("/trial-balance");
  redirect(
    `${PORTFOLIO_PATH}?asOf=${data.asOfDate}&fy=${data.fiscalYearId}&ok=${encodeURIComponent(
      txResult.netDelta === 0
        ? `Revalued ${data.asOfDate} · no change vs prior FVAs · voucher ${txResult.voucherNo}`
        : `Revalued ${data.asOfDate} · Δ ${txResult.netDelta >= 0 ? "+" : "−"}${Math.abs(txResult.netDelta).toFixed(2)} · voucher ${txResult.voucherNo}`,
    )}`,
  );
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
