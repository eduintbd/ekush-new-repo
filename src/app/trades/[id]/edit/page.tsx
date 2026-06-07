// /trades/[id]/edit — correct a mis-keyed trade. Submits to updateTrade,
// which (in one tx) updates the row, re-posts its BV/SV voucher, and
// re-derives the cost basis + SV vouchers of every later sell on the same
// instrument. This is the *only* correct way to fix a trade — editing the
// journal voucher directly leaves the trade row (and the portfolio) stale.

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { updateTrade } from "@/app/trades/actions";
import { TradeForm } from "@/app/trades/trade-form";

type Search = { error?: string };

export const metadata = { title: "Edit trade — Staff portal" };

const numStr = (v: { toString(): string }) => String(Number(v.toString()));

export default async function EditTradePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Search>;
}) {
  await requireRole(["admin", "checker", "accountant"]);
  const { id } = await params;
  const sp = await searchParams;

  const trade = await prisma.trade.findUnique({
    where: { id },
    include: { fiscalYear: { select: { id: true, label: true, isClosed: true } } },
  });
  if (!trade) notFound();

  if (trade.fiscalYear.isClosed) {
    redirect("/trades?error=Trade+is+in+a+closed+fiscal+year");
  }

  const [fiscalYears, instruments, banks, brokers] = await Promise.all([
    prisma.fiscalYear.findMany({ where: { isClosed: false }, orderBy: { startsOn: "desc" } }).catch(() => []),
    prisma.instrument.findMany({ where: { isActive: true }, orderBy: { code: "asc" } }).catch(() => []),
    prisma.bankAccount.findMany({ where: { isActive: true }, orderBy: { accountName: "asc" } }).catch(() => []),
    prisma.broker.findMany({ where: { isActive: true }, orderBy: { name: "asc" } }).catch(() => []),
  ]);

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10 dark:bg-zinc-950">
      <div className="mx-auto max-w-2xl">
        <div className="text-xs uppercase tracking-widest text-zinc-500">
          <Link href="/dashboard" className="hover:text-zinc-700 dark:hover:text-zinc-300">
            ← Dashboard
          </Link>
          <span className="mx-1.5 text-zinc-400">/</span>
          <Link href="/trades" className="hover:text-zinc-700 dark:hover:text-zinc-300">
            Trades
          </Link>
          <span className="mx-1.5 text-zinc-400">/</span>
          <span className="text-zinc-700 dark:text-zinc-300">edit</span>
        </div>
        <h1 className="mt-2 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">Edit trade</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Saving re-posts this trade&apos;s voucher{" "}
          {trade.journalBatchId ? (
            <span className="font-mono">{trade.side === "BUY" ? "BV" : "SV"}</span>
          ) : (
            <span className="italic">(backfilled row — no voucher)</span>
          )}{" "}
          and re-computes the cost basis + sell vouchers of every later trade on{" "}
          <span className="font-mono">{trade.instrumentCode}</span>.
        </p>

        {sp.error && (
          <div className="mt-4 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
            {sp.error}
          </div>
        )}

        <TradeForm
          action={updateTrade}
          hiddenId={trade.id}
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
          submitLabel="Save changes"
        />
      </div>
    </main>
  );
}
