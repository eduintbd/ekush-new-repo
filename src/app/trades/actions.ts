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
  brokerCode: z.string().min(1, "pick a broker"),
  quantity: z.coerce.number().positive("quantity must be > 0"),
  rate: z.coerce.number().positive("rate must be > 0"),
  bankAccount: z.string().min(1, "pick a settlement account"),
  remarks: z.string().optional(),
});

function backWithError(returnPath: string, msg: string): never {
  redirect(`${returnPath}?error=${encodeURIComponent(msg)}`);
}

export async function createTrade(formData: FormData): Promise<void> {
  const profile = await requireRole(["admin", "accountant"]);
  if (!canEdit(profile)) backWithError(TRADE_LIST_PATH, "Insufficient role");

  const parsed = Body.safeParse({
    tradeDate: String(formData.get("tradeDate") ?? ""),
    fiscalYearId: String(formData.get("fiscalYearId") ?? ""),
    instrumentCode: String(formData.get("instrumentCode") ?? ""),
    side: String(formData.get("side") ?? ""),
    brokerCode: String(formData.get("brokerCode") ?? ""),
    quantity: String(formData.get("quantity") ?? ""),
    rate: String(formData.get("rate") ?? ""),
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

  // Broker must exist + be active.
  const broker = await prisma.broker.findUnique({ where: { code: data.brokerCode } });
  if (!broker) backWithError("/trades/new", `Unknown broker "${data.brokerCode}"`);
  if (!broker.isActive) backWithError("/trades/new", `Broker "${data.brokerCode}" is inactive`);

  const grossAmount = round2(data.quantity * data.rate);

  // SELL: compute cost basis from prior-trade history (all prior trades
  // for this instrument across all FYs — cost basis is a running figure).
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
      grossAmount,
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
        brokerCode: data.brokerCode,
        quantity: data.quantity,
        rate: data.rate,
        grossAmount,
        bankAccount: data.bankAccount,
        costBasis,
        realisedPnl,
        journalBatchId: batchId,
        remarks: data.remarks,
        createdBy: profile.id,
      },
    });

    const brokerSuffix = ` via ${broker.name}`;
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
        costBasis,
        realisedPnl,
        voucherNo,
        batchId,
        description: `${baseDescr}${brokerSuffix}`,
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

export async function deleteTrade(formData: FormData): Promise<void> {
  const profile = await requireRole(["admin", "accountant"]);
  if (!canEdit(profile)) redirect(`${TRADE_LIST_PATH}?error=Insufficient+role`);

  const id = String(formData.get("id") ?? "");
  if (!id) redirect(`${TRADE_LIST_PATH}?error=Missing+trade+id`);

  const trade = await prisma.trade.findUnique({ where: { id } });
  if (!trade) redirect(`${TRADE_LIST_PATH}?error=Trade+not+found`);

  const fy = await prisma.fiscalYear.findUnique({ where: { id: trade.fiscalYearId } });
  if (fy?.isClosed) redirect(`${TRADE_LIST_PATH}?error=Fiscal+year+is+closed`);

  // Block delete if any *later* trade on the same instrument exists —
  // those later sells were computed against this trade's contribution to
  // the running cost basis, so removing it would silently invalidate them.
  const later = await prisma.trade.count({
    where: {
      instrumentCode: trade.instrumentCode,
      OR: [
        { tradeDate: { gt: trade.tradeDate } },
        { tradeDate: trade.tradeDate, createdAt: { gt: trade.createdAt } },
      ],
    },
  });
  if (later > 0) {
    redirect(
      `${TRADE_LIST_PATH}?error=${encodeURIComponent(`Cannot delete — ${later} later trade(s) on ${trade.instrumentCode} depend on this row's cost basis. Delete those first.`)}`,
    );
  }

  await withActor(profile.id, async (tx) => {
    if (trade.journalBatchId) {
      await tx.journal.deleteMany({ where: { batchId: trade.journalBatchId } });
    }
    await tx.trade.delete({ where: { id } });
  });

  revalidatePath("/trades");
  revalidatePath("/journals");
  revalidatePath("/day-book");
  revalidatePath("/trial-balance");
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

  if (args.side === "BUY") {
    return [
      // dr investment account
      { ...base, txnType: "BV", accountName: args.investmentAccount, debit: args.grossAmount, credit: 0 },
      // cr bank
      { ...base, txnType: "BV", accountName: args.bankAccount, debit: 0, credit: args.grossAmount },
    ];
  }

  // SELL: dr bank (gross), cr investment (cost basis), then dr/cr realised P&L
  const cost = args.costBasis ?? 0;
  const pnl = args.realisedPnl ?? 0;
  const lines = [
    { ...base, txnType: "SV", accountName: args.bankAccount, debit: args.grossAmount, credit: 0 },
    { ...base, txnType: "SV", accountName: args.investmentAccount, debit: 0, credit: cost },
  ];
  if (Math.abs(pnl) >= 0.005) {
    if (pnl > 0) {
      // realised gain → credit (book-keeping convention)
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
