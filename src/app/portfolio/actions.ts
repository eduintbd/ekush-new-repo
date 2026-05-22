"use server";

// FVTPL revaluation. Click "Revalue to market" on /portfolio → this
// action computes per-instrument unrealised P&L using the cost-basis
// engine joined with the latest Price (≤ asOfDate), and posts a single
// compound journal:
//
//   if net unrealised gain > 0:
//     dr Fair Value Reserve (BS, equity)
//     cr Unrealised Gain/(Loss) on Investments (P&L)
//   if net unrealised loss > 0:
//     dr Unrealised Gain/(Loss) on Investments
//     cr Fair Value Reserve
//
// A FairValueAdjustment audit row links the journal batch. Re-running
// for the same `asOfDate` first reverses the prior active FVA (one
// opposite-sign journal posted, prior row's `reversedAt` set) and then
// posts a fresh one. Idempotent across runs.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { prisma, withActor } from "@/lib/prisma";
import { requireRole, canEdit } from "@/lib/auth";
import { allocateVoucherNo } from "@/lib/voucher";
import { buildPortfolioAsOf, fromPrismaTrades, latestPricesMap } from "@/lib/portfolio";

const FAIR_VALUE_RESERVE = "Fair Value Reserve";
const UNREALISED = "Unrealised Gain/(Loss) on Investments";
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

  // Make sure the CoA targets exist (defence — they're seeded but a
  // human could have deactivated them).
  const accs = await prisma.chartOfAccount.findMany({
    where: { name: { in: [FAIR_VALUE_RESERVE, UNREALISED] } },
    select: { name: true },
  });
  const found = new Set(accs.map((a) => a.name));
  if (!found.has(FAIR_VALUE_RESERVE) || !found.has(UNREALISED)) {
    back(baseQs, `Missing CoA target — need "${FAIR_VALUE_RESERVE}" and "${UNREALISED}"`);
  }

  // Replay trades up to asOfDate + join latest price ≤ asOfDate.
  const tradeRows = await prisma.trade.findMany({
    where: { tradeDate: { lte: asOf } },
    orderBy: [{ tradeDate: "asc" }, { createdAt: "asc" }],
  });
  const priceRows = await prisma.price.findMany({
    where: { priceDate: { lte: asOf } },
  });

  const portfolio = buildPortfolioAsOf(fromPrismaTrades(tradeRows), latestPricesMap(priceRows), asOf);
  const priced = portfolio.filter((r) => r.unrealisedPnl !== null);
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

  const totalCost = round2(priced.reduce((s, r) => s + r.totalCost, 0));
  const totalMarket = round2(priced.reduce((s, r) => s + (r.marketValue ?? 0), 0));
  const unrealised = round2(totalMarket - totalCost);

  // Inside one tx: reverse prior active FVA (if any) → post new one.
  const newBatchId = randomUUID();
  let newVoucherNo = "";
  await withActor(profile.id, async (tx) => {
    const priorActive = await tx.fairValueAdjustment.findFirst({
      where: { fiscalYearId: data.fiscalYearId, asOfDate: asOf, reversedAt: null },
    });

    if (priorActive) {
      // Post the reversal: same legs, swapped sides.
      const reversalBatch = randomUUID();
      const reversalVoucher = await allocateVoucherNo(tx, data.fiscalYearId, fy.label, "FV");
      const priorAmt = round2(Number(priorActive.unrealisedPnl));
      if (Math.abs(priorAmt) >= 0.005) {
        const dirGain = priorAmt > 0;
        await tx.journal.createMany({
          data: [
            // If prior posted a gain (cr Unrealised), reversal cr Fair Value Reserve, dr Unrealised
            {
              entryDate: asOf,
              description: `FVTPL reversal (was ${priorAmt >= 0 ? "+" : "−"}${Math.abs(priorAmt).toFixed(2)})`,
              txnType: "FV",
              voucherNo: reversalVoucher,
              accountName: FAIR_VALUE_RESERVE,
              debit: dirGain ? Math.abs(priorAmt) : 0,
              credit: dirGain ? 0 : Math.abs(priorAmt),
              fiscalYearId: data.fiscalYearId,
              batchId: reversalBatch,
              createdBy: profile.id,
            },
            {
              entryDate: asOf,
              description: `FVTPL reversal (was ${priorAmt >= 0 ? "+" : "−"}${Math.abs(priorAmt).toFixed(2)})`,
              txnType: "FV",
              voucherNo: reversalVoucher,
              accountName: UNREALISED,
              debit: dirGain ? 0 : Math.abs(priorAmt),
              credit: dirGain ? Math.abs(priorAmt) : 0,
              fiscalYearId: data.fiscalYearId,
              batchId: reversalBatch,
              createdBy: profile.id,
            },
          ],
        });
      }
      await tx.fairValueAdjustment.update({
        where: { id: priorActive.id },
        data: { reversedAt: new Date() },
      });
    }

    // Post the new FVTPL journal.
    newVoucherNo = await allocateVoucherNo(tx, data.fiscalYearId, fy.label, "FV");
    if (Math.abs(unrealised) >= 0.005) {
      const isGain = unrealised > 0;
      await tx.journal.createMany({
        data: [
          {
            entryDate: asOf,
            description: `FVTPL revaluation as of ${data.asOfDate} (${isGain ? "gain" : "loss"})`,
            txnType: "FV",
            voucherNo: newVoucherNo,
            accountName: FAIR_VALUE_RESERVE,
            debit: isGain ? Math.abs(unrealised) : 0,
            credit: isGain ? 0 : Math.abs(unrealised),
            fiscalYearId: data.fiscalYearId,
            batchId: newBatchId,
            createdBy: profile.id,
          },
          {
            entryDate: asOf,
            description: `FVTPL revaluation as of ${data.asOfDate} (${isGain ? "gain" : "loss"})`,
            txnType: "FV",
            voucherNo: newVoucherNo,
            accountName: UNREALISED,
            debit: isGain ? 0 : Math.abs(unrealised),
            credit: isGain ? Math.abs(unrealised) : 0,
            fiscalYearId: data.fiscalYearId,
            batchId: newBatchId,
            createdBy: profile.id,
          },
        ],
      });
    }

    await tx.fairValueAdjustment.create({
      data: {
        asOfDate: asOf,
        fiscalYearId: data.fiscalYearId,
        journalBatchId: newBatchId,
        totalCost,
        totalMarket,
        unrealisedPnl: unrealised,
        createdBy: profile.id,
      },
    });
  });

  revalidatePath("/portfolio");
  revalidatePath("/journals");
  revalidatePath("/day-book");
  revalidatePath("/trial-balance");
  redirect(
    `${PORTFOLIO_PATH}?asOf=${data.asOfDate}&fy=${data.fiscalYearId}&ok=${encodeURIComponent(
      `Revalued: ${unrealised >= 0 ? "+" : "−"}${Math.abs(unrealised).toFixed(2)} unrealised · voucher ${newVoucherNo}`,
    )}`,
  );
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
