"use server";

// Trade entry server actions. Every Trade row spawns one Journal voucher
// (prefix BV / SV) so the books always reflect what was traded. Cost
// basis on sells is computed by replaying every prior trade for the same
// instrument (weighted-average); see src/lib/portfolio.ts for the math.
//
// Idempotency: createTrade is non-idempotent (the caller's <FormGuard>
// disables the submit button), but the auto-journal step is keyed on
// `Trade.journalBatchId IS NULL` so if a tx aborts after the trade
// insert but before the journal post, a follow-up retry can complete it.
//
// On update/delete: the existing journal voucher is deleted first, then
// the trade row is updated/deleted, then (for update) a fresh voucher is
// posted. This keeps day-book in sync without any day-book changes.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma";
import { prisma, withActor } from "@/lib/prisma";
import { requireRole, canEdit } from "@/lib/auth";
import { allocateVoucherNo, type VoucherPrefix } from "@/lib/voucher";
import { costBasisOnSell, fromPrismaTrades } from "@/lib/portfolio";

const TRADE_LIST_PATH = "/trades";

const Body = z.object({
  tradeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "trade date required"),
  fiscalYearId: z.string().min(1),
  instrumentCode: z.string().min(1, "pick an instrument"),
  side: z.enum(["BUY", "SELL"]),
  // Optional: own-fund subscriptions (EFUF/EGF/ESRF) are placed directly
  // with the asset manager (EWML), not a broker — empty means "no broker".
  brokerCode: z.string().optional().default(""),
  quantity: z.coerce.number().positive("quantity must be > 0"),
  rate: z.coerce.number().positive("rate must be > 0"),
  commission: z.coerce.number().min(0, "commission must be ≥ 0").default(0),
  bankAccount: z.string().min(1, "pick a settlement account"),
  remarks: z.string().optional(),
});

function backWithError(returnPath: string, msg: string): never {
  redirect(`${returnPath}?error=${encodeURIComponent(msg)}`);
}

export async function createTrade(formData: FormData): Promise<void> {
  const profile = await requireRole(["admin", "checker", "accountant"]);
  if (!canEdit(profile)) backWithError(TRADE_LIST_PATH, "Insufficient role");

  const parsed = Body.safeParse({
    tradeDate: String(formData.get("tradeDate") ?? ""),
    fiscalYearId: String(formData.get("fiscalYearId") ?? ""),
    instrumentCode: String(formData.get("instrumentCode") ?? ""),
    side: String(formData.get("side") ?? ""),
    brokerCode: String(formData.get("brokerCode") ?? ""),
    quantity: String(formData.get("quantity") ?? ""),
    rate: String(formData.get("rate") ?? ""),
    commission: String(formData.get("commission") ?? "0"),
    bankAccount: String(formData.get("bankAccount") ?? ""),
    remarks: String(formData.get("remarks") ?? "") || undefined,
  });
  if (!parsed.success) backWithError("/trades/new", parsed.error.issues[0]?.message ?? "invalid");
  const data = parsed.data;

  // Fiscal year must be open and contain trade date.
  const fy = await prisma.fiscalYear.findUnique({ where: { id: data.fiscalYearId } });
  if (!fy) backWithError("/trades/new", "Fiscal year not found");
  if (fy.isClosed) backWithError("/trades/new", "Fiscal year is closed");
  const tradeDate = new Date(`${data.tradeDate}T00:00:00Z`);
  if (tradeDate < fy.startsOn || tradeDate > fy.endsOn) {
    backWithError("/trades/new", "Trade date is outside the selected fiscal year");
  }

  // Instrument must exist and be active.
  const instrument = await prisma.instrument.findUnique({ where: { code: data.instrumentCode } });
  if (!instrument) backWithError("/trades/new", `Unknown instrument "${data.instrumentCode}"`);
  if (!instrument.isActive) backWithError("/trades/new", `Instrument "${data.instrumentCode}" is inactive`);

  // Bank account must exist as a CoA row.
  const bank = await prisma.chartOfAccount.findUnique({ where: { name: data.bankAccount } });
  if (!bank) backWithError("/trades/new", `Unknown bank account "${data.bankAccount}"`);

  // Investment-leg account (from instrument) must also exist.
  const invAcc = await prisma.chartOfAccount.findUnique({ where: { name: instrument.investmentAccount } });
  if (!invAcc) backWithError("/trades/new", `Investment account "${instrument.investmentAccount}" missing from CoA`);

  // Broker is optional: own-fund subscriptions (EFUF/EGF/ESRF) are placed
  // directly with the asset manager (EWML), so brokerCode is left null and
  // the voucher narration reads "via EWML (Asset Manager)". When a broker
  // IS picked it must exist + be active.
  const brokerCode = data.brokerCode.trim() ? data.brokerCode.trim() : null;
  let brokerName = "EWML (Asset Manager)";
  if (brokerCode) {
    const broker = await prisma.broker.findUnique({ where: { code: brokerCode } });
    if (!broker) backWithError("/trades/new", `Unknown broker "${brokerCode}"`);
    if (!broker.isActive) backWithError("/trades/new", `Broker "${brokerCode}" is inactive`);
    brokerName = broker.name;
  }

  const grossAmount = round2(data.quantity * data.rate);
  const commission = round2(data.commission);

  // SELL: compute cost basis from prior-trade history (all prior trades
  // for this instrument across all FYs — cost basis is a running figure).
  // Commission is netted from proceeds (IFRS 9), so we pass
  // gross − commission into the engine; resulting realisedPnl already
  // reflects the fee deduction.
  let costBasis: number | null = null;
  let realisedPnl: number | null = null;
  if (data.side === "SELL") {
    const priorRows = await prisma.trade.findMany({
      where: { instrumentCode: data.instrumentCode, tradeDate: { lte: tradeDate } },
      orderBy: [{ tradeDate: "asc" }, { createdAt: "asc" }],
    });
    const snap = costBasisOnSell(fromPrismaTrades(priorRows), {
      instrumentCode: data.instrumentCode,
      quantity: data.quantity,
      grossAmount: grossAmount - commission,
    });
    if (snap.quantityAfter < -0.0001) {
      backWithError(
        "/trades/new",
        `Sell qty ${data.quantity} exceeds available holding (${snap.quantityAfter + data.quantity} units before this trade)`,
      );
    }
    costBasis = round2(snap.costBasis);
    realisedPnl = round2(snap.realisedPnl);
  }

  // Insert trade + post journal in one tx (audit-log trigger sees the
  // right actor via SET LOCAL xsystem.actor_uuid inside withActor).
  const tradeId = randomUUID();
  const batchId = randomUUID();
  let voucherNo = "";
  await withActor(profile.id, async (tx) => {
    const prefix: VoucherPrefix = data.side === "BUY" ? "BV" : "SV";
    voucherNo = await allocateVoucherNo(tx, data.fiscalYearId, fy.label, prefix);

    await tx.trade.create({
      data: {
        id: tradeId,
        tradeDate,
        fiscalYearId: data.fiscalYearId,
        instrumentCode: data.instrumentCode,
        side: data.side,
        brokerCode,
        quantity: data.quantity,
        rate: data.rate,
        grossAmount,
        commission,
        bankAccount: data.bankAccount,
        costBasis,
        realisedPnl,
        journalBatchId: batchId,
        remarks: data.remarks,
        createdBy: profile.id,
      },
    });

    const brokerSuffix = ` via ${brokerName}`;
    const commSuffix = commission > 0 ? ` · comm ${commission.toFixed(2)}` : "";
    const baseDescr = data.remarks ?? `${data.side} ${data.quantity} ${data.instrumentCode} @ ${data.rate}`;
    await tx.journal.createMany({
      data: buildJournalLines({
        side: data.side,
        entryDate: tradeDate,
        fiscalYearId: data.fiscalYearId,
        instrumentCode: data.instrumentCode,
        investmentAccount: instrument.investmentAccount,
        bankAccount: data.bankAccount,
        grossAmount,
        commission,
        costBasis,
        realisedPnl,
        voucherNo,
        batchId,
        description: `${baseDescr}${brokerSuffix}${commSuffix}`,
        createdBy: profile.id,
      }),
    });
  });

  revalidatePath("/trades");
  revalidatePath("/journals");
  revalidatePath("/day-book");
  revalidatePath("/trial-balance");
  redirect(`/trades?ok=${encodeURIComponent(`Trade saved · voucher ${voucherNo}`)}`);
}

/**
 * Edit an existing trade and re-derive every dependency in one tx. The
 * trade is the system-of-record; its BV/SV voucher, its own cost basis,
 * and the cost basis + SV vouchers of every *later* sell on the same
 * instrument are all regenerated so the trade ledger, the GL, and the
 * /portfolio view never diverge. (Editing the voucher directly — the old
 * workaround — only touched the GL and left the trade row stale.)
 *
 * Backfilled rows (journalBatchId = null) stay journal-less by design:
 * the row is updated and cost basis re-derived, but no BV/SV is posted
 * (legacy hand-entered journals already cover that period).
 */
export async function updateTrade(formData: FormData): Promise<void> {
  const profile = await requireRole(["admin", "checker", "accountant"]);
  const id = String(formData.get("id") ?? "");
  const editPath = id ? `/trades/${id}/edit` : TRADE_LIST_PATH;
  if (!canEdit(profile)) backWithError(editPath, "Insufficient role");
  if (!id) backWithError(TRADE_LIST_PATH, "Missing trade id");

  const existing = await prisma.trade.findUnique({ where: { id } });
  if (!existing) backWithError(TRADE_LIST_PATH, "Trade not found");

  const parsed = Body.safeParse({
    tradeDate: String(formData.get("tradeDate") ?? ""),
    fiscalYearId: String(formData.get("fiscalYearId") ?? ""),
    instrumentCode: String(formData.get("instrumentCode") ?? ""),
    side: String(formData.get("side") ?? ""),
    brokerCode: String(formData.get("brokerCode") ?? ""),
    quantity: String(formData.get("quantity") ?? ""),
    rate: String(formData.get("rate") ?? ""),
    commission: String(formData.get("commission") ?? "0"),
    bankAccount: String(formData.get("bankAccount") ?? ""),
    remarks: String(formData.get("remarks") ?? "") || undefined,
  });
  if (!parsed.success) backWithError(editPath, parsed.error.issues[0]?.message ?? "invalid");
  const data = parsed.data;

  // FY must be open and contain the (possibly new) trade date. Also block
  // if the trade is currently in a closed FY (can't move it out).
  const fy = await prisma.fiscalYear.findUnique({ where: { id: data.fiscalYearId } });
  if (!fy) backWithError(editPath, "Fiscal year not found");
  if (fy.isClosed) backWithError(editPath, "Fiscal year is closed");
  const tradeDate = new Date(`${data.tradeDate}T00:00:00Z`);
  if (tradeDate < fy.startsOn || tradeDate > fy.endsOn) {
    backWithError(editPath, "Trade date is outside the selected fiscal year");
  }
  if (existing.fiscalYearId !== data.fiscalYearId) {
    const oldFy = await prisma.fiscalYear.findUnique({ where: { id: existing.fiscalYearId } });
    if (oldFy?.isClosed) backWithError(editPath, "Original fiscal year is closed");
  }

  const instrument = await prisma.instrument.findUnique({ where: { code: data.instrumentCode } });
  if (!instrument) backWithError(editPath, `Unknown instrument "${data.instrumentCode}"`);
  if (!instrument.isActive) backWithError(editPath, `Instrument "${data.instrumentCode}" is inactive`);

  const bank = await prisma.chartOfAccount.findUnique({ where: { name: data.bankAccount } });
  if (!bank) backWithError(editPath, `Unknown bank account "${data.bankAccount}"`);
  // Broker optional (see createTrade). Validate only when one is picked;
  // empty means a direct asset-manager subscription → null brokerCode.
  const brokerCode = data.brokerCode.trim() ? data.brokerCode.trim() : null;
  if (brokerCode) {
    const broker = await prisma.broker.findUnique({ where: { code: brokerCode } });
    if (!broker) backWithError(editPath, `Unknown broker "${brokerCode}"`);
    if (!broker.isActive) backWithError(editPath, `Broker "${brokerCode}" is inactive`);
  }

  const grossAmount = round2(data.quantity * data.rate);
  const commission = round2(data.commission);
  const oldInstrument = existing.instrumentCode;

  try {
    await withActor(profile.id, async (tx) => {
      await tx.trade.update({
        where: { id },
        data: {
          tradeDate,
          fiscalYearId: data.fiscalYearId,
          instrumentCode: data.instrumentCode,
          side: data.side,
          brokerCode,
          quantity: data.quantity,
          rate: data.rate,
          grossAmount,
          commission,
          bankAccount: data.bankAccount,
          remarks: data.remarks,
        },
      });
      // Re-derive cost basis + re-post vouchers for the (new) instrument,
      // forcing a re-post of this edited row's own voucher. If the
      // instrument changed, the old instrument's chain must be fixed too.
      await recomputeInstrument(tx, data.instrumentCode, profile.id, id);
      if (oldInstrument !== data.instrumentCode) {
        await recomputeInstrument(tx, oldInstrument, profile.id);
      }
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith("NEGATIVE_HOLDING:")) {
      backWithError(editPath, `Edit rejected — it would drive ${msg.slice("NEGATIVE_HOLDING:".length)} into a negative holding. Fix the dependent sell(s) first.`);
    }
    console.error("[updateTrade] failed:", err);
    backWithError(editPath, `Update failed: ${msg.slice(0, 160)}`);
  }

  revalidatePath("/trades");
  revalidatePath("/journals");
  revalidatePath("/day-book");
  revalidatePath("/trial-balance");
  revalidatePath("/portfolio");
  redirect(`/trades?ok=${encodeURIComponent(`Trade updated · ${data.side} ${data.instrumentCode}`)}`);
}

/**
 * Replay a single instrument's trade stream and bring every derived
 * artifact back in line with the trade rows: each SELL's costBasis /
 * realisedPnl, and each trade-backed voucher (re-posted to match).
 *
 * Re-post policy (minimise churn):
 *   - BUY vouchers depend only on the row itself (gross+commission), so
 *     only the explicitly-edited buy (`forceTradeId`) is re-posted.
 *   - SELL vouchers depend on prior history, so any sell whose cost basis
 *     drifted — plus the edited sell — is re-posted.
 *   - Backfilled rows (journalBatchId = null) are never given a voucher.
 *
 * Throws `NEGATIVE_HOLDING:<code> on <date>` to roll the whole tx back if
 * any sell would exceed the running holding.
 */
async function recomputeInstrument(
  tx: Prisma.TransactionClient,
  instrumentCode: string,
  profileId: string,
  forceTradeId?: string,
): Promise<void> {
  const inst = await tx.instrument.findUnique({ where: { code: instrumentCode } });
  if (!inst) throw new Error(`Instrument ${instrumentCode} not in master`);

  const trades = await tx.trade.findMany({
    where: { instrumentCode },
    orderBy: [{ tradeDate: "asc" }, { createdAt: "asc" }],
  });
  const batchIds = trades.map((t) => t.journalBatchId).filter((b): b is string => Boolean(b));
  const heads = batchIds.length
    ? await tx.journal.findMany({
        where: { batchId: { in: batchIds } },
        select: { batchId: true, voucherNo: true, description: true, createdBy: true },
      })
    : [];
  const headByBatch = new Map<string, { voucherNo: string | null; description: string | null; createdBy: string | null }>();
  for (const h of heads) if (h.batchId && !headByBatch.has(h.batchId)) headByBatch.set(h.batchId, h);

  let qty = 0;
  let totalCost = 0;
  for (const t of trades) {
    const q = Number(t.quantity);
    const rate = Number(t.rate);
    const gross = Number(t.grossAmount);
    const comm = Number(t.commission ?? 0);
    let costBasis: number | null = null;
    let realisedPnl: number | null = null;

    if (t.side === "BUY") {
      qty += q;
      totalCost += q * rate + comm;
    } else {
      if (q - qty > 0.0001) {
        throw new Error(`NEGATIVE_HOLDING:${instrumentCode} on ${t.tradeDate.toISOString().slice(0, 10)}`);
      }
      const avg = qty > 0 ? totalCost / qty : 0;
      costBasis = round2(avg * q);
      realisedPnl = round2(gross - comm - avg * q);
      qty -= q;
      totalCost = avg * qty;
      const drift =
        Math.abs(Number(t.costBasis ?? 0) - costBasis) > 0.005 ||
        Math.abs(Number(t.realisedPnl ?? 0) - realisedPnl) > 0.005;
      if (drift) {
        await tx.trade.update({ where: { id: t.id }, data: { costBasis, realisedPnl } });
      }
    }

    const mustRepost = t.journalBatchId && (t.id === forceTradeId || (t.side === "SELL" && needsRepost(t, costBasis, realisedPnl)));
    if (t.journalBatchId && mustRepost) {
      const head = headByBatch.get(t.journalBatchId);
      await tx.journal.deleteMany({ where: { batchId: t.journalBatchId } });
      await tx.journal.createMany({
        data: buildJournalLines({
          side: t.side,
          entryDate: t.tradeDate,
          fiscalYearId: t.fiscalYearId,
          instrumentCode: t.instrumentCode,
          investmentAccount: inst.investmentAccount,
          bankAccount: t.bankAccount,
          grossAmount: gross,
          commission: comm,
          costBasis,
          realisedPnl,
          voucherNo: head?.voucherNo ?? "",
          batchId: t.journalBatchId,
          description: head?.description ?? `${t.side} ${q} ${instrumentCode}`,
          createdBy: head?.createdBy ?? profileId,
        }),
      });
    }
  }
}

/** A sell voucher needs re-posting when its recomputed cost basis /
 *  realised P&L no longer match the row that was just (or will be) saved. */
function needsRepost(
  t: { costBasis: Prisma.Decimal | null; realisedPnl: Prisma.Decimal | null },
  costBasis: number | null,
  realisedPnl: number | null,
): boolean {
  return (
    Math.abs(Number(t.costBasis ?? 0) - (costBasis ?? 0)) > 0.005 ||
    Math.abs(Number(t.realisedPnl ?? 0) - (realisedPnl ?? 0)) > 0.005
  );
}

export async function deleteTrade(formData: FormData): Promise<void> {
  const profile = await requireRole(["admin", "checker", "accountant"]);
  if (!canEdit(profile)) redirect(`${TRADE_LIST_PATH}?error=Insufficient+role`);

  const id = String(formData.get("id") ?? "");
  if (!id) redirect(`${TRADE_LIST_PATH}?error=Missing+trade+id`);

  const trade = await prisma.trade.findUnique({ where: { id } });
  if (!trade) redirect(`${TRADE_LIST_PATH}?error=Trade+not+found`);

  const fy = await prisma.fiscalYear.findUnique({ where: { id: trade.fiscalYearId } });
  if (fy?.isClosed) redirect(`${TRADE_LIST_PATH}?error=Fiscal+year+is+closed`);

  // Delete the row + its voucher, then re-derive the rest of the
  // instrument's chain so later sells' cost basis + SV vouchers stay
  // correct. Rolls back (and reports) if removing this row would drive a
  // later sell negative.
  try {
    await withActor(profile.id, async (tx) => {
      if (trade.journalBatchId) {
        await tx.journal.deleteMany({ where: { batchId: trade.journalBatchId } });
      }
      await tx.trade.delete({ where: { id } });
      await recomputeInstrument(tx, trade.instrumentCode, profile.id);
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith("NEGATIVE_HOLDING:")) {
      redirect(
        `${TRADE_LIST_PATH}?error=${encodeURIComponent(`Cannot delete — it would drive ${msg.slice("NEGATIVE_HOLDING:".length)} into a negative holding. Delete the dependent sell(s) first.`)}`,
      );
    }
    throw err;
  }

  revalidatePath("/trades");
  revalidatePath("/journals");
  revalidatePath("/day-book");
  revalidatePath("/trial-balance");
  revalidatePath("/portfolio");
  redirect(`${TRADE_LIST_PATH}?ok=${encodeURIComponent(`Trade deleted (voucher ${trade.journalBatchId ? "removed" : "n/a"})`)}`);
}

// ─── Journal-line builder ────────────────────────────────────────

function buildJournalLines(args: {
  side: "BUY" | "SELL";
  entryDate: Date;
  fiscalYearId: string;
  instrumentCode: string;
  investmentAccount: string;
  bankAccount: string;
  grossAmount: number;
  /** Broker commission, BDT. Capitalized into the BUY cost; netted
   *  from SELL proceeds. */
  commission: number;
  costBasis: number | null;
  realisedPnl: number | null;
  voucherNo: string;
  batchId: string;
  description: string;
  createdBy: string;
}) {
  const REALISED = "Realised Gain/(Loss) on Investments";
  const base = {
    entryDate: args.entryDate,
    description: args.description,
    voucherNo: args.voucherNo,
    fiscalYearId: args.fiscalYearId,
    batchId: args.batchId,
    instrumentCode: args.instrumentCode,
    createdBy: args.createdBy,
  };
  const commission = args.commission ?? 0;

  if (args.side === "BUY") {
    // IFRS 9: commission CAPITALIZED into cost basis. Both legs swell
    // by the same amount so the voucher still balances.
    const buyCost = args.grossAmount + commission;
    return [
      { ...base, txnType: "BV", accountName: args.investmentAccount, debit: buyCost, credit: 0 },
      { ...base, txnType: "BV", accountName: args.bankAccount, debit: 0, credit: buyCost },
    ];
  }

  // SELL: net proceeds = gross − commission. Settlement leg debits
  // net proceeds; investment leg credits cost basis; realised G/L is
  // the difference (already computed by the caller via
  // costBasisOnSell with grossAmount = gross − commission).
  const cost = args.costBasis ?? 0;
  const pnl = args.realisedPnl ?? 0;
  const netProceeds = args.grossAmount - commission;
  const lines = [
    { ...base, txnType: "SV", accountName: args.bankAccount, debit: netProceeds, credit: 0 },
    { ...base, txnType: "SV", accountName: args.investmentAccount, debit: 0, credit: cost },
  ];
  if (Math.abs(pnl) >= 0.005) {
    if (pnl > 0) {
      // realised gain → credit
      lines.push({ ...base, txnType: "SV", accountName: REALISED, debit: 0, credit: Math.abs(pnl) });
    } else {
      // realised loss → debit
      lines.push({ ...base, txnType: "SV", accountName: REALISED, debit: Math.abs(pnl), credit: 0 });
    }
  }
  return lines;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
