// /trades/new — single-form entry for one buy/sell. On submit:
//   1. Trade row inserted.
//   2. If SELL, weighted-avg cost basis + realised P&L snapshotted onto
//      the row from prior-trade history for the same instrument.
//   3. A Journal voucher (prefix BV / SV) is auto-posted to the day-book.
//
// The form inherits pending-state + flash-toast from the global
// <FormGuard> / <FlashToast> — no per-page wiring.

import Link from "next/link";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { createTrade } from "@/app/trades/actions";
import { TradeForm } from "@/app/trades/trade-form";

type Search = {
  error?: string;
  defaultSide?: "BUY" | "SELL";
  // Prefill (used by the reconciliation report's "add missing trade" links).
  tradeDate?: string;
  instrumentCode?: string;
  side?: "BUY" | "SELL";
  quantity?: string;
  rate?: string;
  commission?: string;
};

export const metadata = { title: "New trade — Staff portal" };

export default async function NewTradePage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  await requireRole(["admin", "checker", "accountant"]);
  const sp = await searchParams;

  const [fiscalYears, instruments, banks, brokers] = await Promise.all([
    prisma.fiscalYear
      .findMany({ where: { isClosed: false }, orderBy: { startsOn: "desc" } })
      .catch(() => []),
    prisma.instrument
      .findMany({ where: { isActive: true }, orderBy: { code: "asc" } })
      .catch(() => []),
    prisma.bankAccount
      .findMany({ where: { isActive: true }, orderBy: { accountName: "asc" } })
      .catch(() => []),
    prisma.broker
      .findMany({ where: { isActive: true }, orderBy: { name: "asc" } })
      .catch(() => []),
  ]);

  if (fiscalYears.length === 0) {
    redirect("/trades?error=No+open+fiscal+year");
  }
  if (instruments.length === 0) {
    redirect("/trades?error=No+active+instruments+%E2%80%94+seed+them+first");
  }
  if (banks.length === 0) {
    redirect("/trades?error=No+active+bank+accounts");
  }
  if (brokers.length === 0) {
    redirect("/trades?error=No+active+brokers+%E2%80%94+add+one+at+%2Fadmin%2Fbrokers");
  }

  const today = new Date().toISOString().slice(0, 10);

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
        </div>
        <h1 className="mt-2 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">New trade</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          On save, the matching journal voucher (BV / SV) is auto-posted to the day-book. For
          SELL, weighted-average cost basis and realised P&amp;L are computed from prior trades
          on the same instrument.
        </p>

        {sp.error && (
          <div className="mt-4 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
            {sp.error}
          </div>
        )}

        <TradeForm
          action={createTrade}
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
            tradeDate: sp.tradeDate ?? today,
            fiscalYearId: fiscalYears[0].id,
            side: sp.side ?? sp.defaultSide ?? "BUY",
            brokerCode: brokers[0]?.code ?? "",
            instrumentCode: sp.instrumentCode ?? "",
            bankAccount: "",
            quantity: sp.quantity ?? "",
            rate: sp.rate ?? "",
            commission: sp.commission ?? "0",
            remarks: "",
          }}
          submitLabel="Save trade"
        />
      </div>
    </main>
  );
}
