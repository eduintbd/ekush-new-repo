// Shared trade-editor: renders the TradeForm bound to updateTrade, with the
// option lists fetched. Used by both /trades/[id]/edit and the BV/SV journal
// voucher Edit page so "editing the voucher" actually edits the trade —
// which re-posts the voucher AND recomputes the portfolio in one tx.

import type { Trade } from "@/generated/prisma";
import { prisma } from "@/lib/prisma";
import { updateTrade } from "@/app/trades/actions";
import { TradeForm } from "@/app/trades/trade-form";

const numStr = (v: { toString(): string }) => String(Number(v.toString()));

export async function TradeEditor({
  trade,
  returnTo,
  submitLabel = "Save changes",
}: {
  trade: Trade;
  /** Internal path to return to after save (e.g. "/day-book"). */
  returnTo?: string;
  submitLabel?: string;
}) {
  const [fiscalYears, instruments, banks, brokers] = await Promise.all([
    prisma.fiscalYear.findMany({ where: { isClosed: false }, orderBy: { startsOn: "desc" } }).catch(() => []),
    prisma.instrument.findMany({ where: { isActive: true }, orderBy: { code: "asc" } }).catch(() => []),
    prisma.bankAccount.findMany({ where: { isActive: true }, orderBy: { accountName: "asc" } }).catch(() => []),
    prisma.broker.findMany({ where: { isActive: true }, orderBy: { name: "asc" } }).catch(() => []),
  ]);

  return (
    <TradeForm
      action={updateTrade}
      hiddenId={trade.id}
      returnTo={returnTo}
      fiscalYears={fiscalYears.map((y) => ({ id: y.id, label: y.label }))}
      instruments={instruments.map((i) => ({ code: i.code, name: i.name }))}
      banks={banks.map((b) => ({ id: b.id, accountName: b.accountName, accountType: b.accountType }))}
      brokers={brokers.map((b) => ({
        code: b.code,
        name: b.name,
        brokerBoAccount: b.brokerBoAccount,
        marginLoanAccount: b.marginLoanAccount,
        accountNumber: b.accountNumber,
      }))}
      initial={{
        tradeDate: trade.tradeDate.toISOString().slice(0, 10),
        fiscalYearId: trade.fiscalYearId,
        side: trade.side as "BUY" | "SELL",
        brokerCode: trade.brokerCode ?? "",
        instrumentCode: trade.instrumentCode,
        bankAccount: trade.bankAccount,
        quantity: numStr(trade.quantity),
        rate: numStr(trade.rate),
        commission: numStr(trade.commission),
        remarks: trade.remarks ?? "",
      }}
      submitLabel={submitLabel}
    />
  );
}
