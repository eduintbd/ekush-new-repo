// /agent — selling-agent landing (spec §6.2). Surfaces three KPI cards
// (initial AUM under my code, accrued this quarter, last paid quarter)
// and links to the per-investor and per-commission detail pages.

import Link from "next/link";
import { requireAgent } from "@/lib/auth";
import { signOut } from "@/app/login/actions";
import { prisma } from "@/lib/prisma";
import { formatBdt } from "@/lib/format";
import { calendarQuarter, todayUtc } from "@/lib/cron-auth";

async function loadKpis(agentId: string) {
  const quarter = calendarQuarter(todayUtc());
  // Prefer the daily-accrual snapshot (cheap to read); fall back to live
  // CommissionRun aggregation if no snapshot has run yet.
  const [investorAum, latestAccrual, accruedThisQLive, lastPaid] = await Promise.all([
    prisma.agentInvestor
      .aggregate({ where: { agentId }, _sum: { initialGrossAmount: true } })
      .catch(() => null),
    prisma.commissionAccrual
      .findFirst({ where: { agentId }, orderBy: [{ snapshotDate: "desc" }] })
      .catch(() => null),
    prisma.commissionRun
      .aggregate({
        where: {
          agentId,
          periodEnd: { gte: quarter.start, lt: quarter.end },
          status: { in: ["accrued", "approved", "paid"] },
        },
        _sum: { amount: true },
      })
      .catch(() => null),
    prisma.commissionRun
      .findFirst({
        where: { agentId, status: "paid" },
        orderBy: [{ paidOn: "desc" }],
        select: { paidOn: true, periodStart: true, periodEnd: true, amount: true },
      })
      .catch(() => null),
  ]);

  const accruedThisQuarter =
    latestAccrual && latestAccrual.snapshotDate >= quarter.start
      ? Number(latestAccrual.quarterToDateBdt)
      : Number(accruedThisQLive?._sum.amount ?? 0);

  return {
    quarter,
    initialAum: Number(investorAum?._sum.initialGrossAmount ?? 0),
    accruedThisQuarter,
    accrualSnapshotAt: latestAccrual?.snapshotDate ?? null,
    lastPaid,
  };
}

export default async function AgentDashboardPage() {
  const profile = await requireAgent();
  const agent = await prisma.sellingAgent
    .findUnique({ where: { userId: profile.id } })
    .catch(() => null);

  return (
    <main className="min-h-screen bg-emerald-50/30 dark:bg-emerald-950/30">
      <header className="border-b border-emerald-200 bg-white px-6 py-4 dark:border-emerald-900 dark:bg-zinc-900">
        <div className="mx-auto flex max-w-6xl items-center justify-between">
          <div>
            <p className="text-xs uppercase tracking-widest text-emerald-700 dark:text-emerald-300">
              Selling agent
            </p>
            <h1 className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
              Agent dashboard
            </h1>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-zinc-600 dark:text-zinc-400">
              {profile.fullName ?? profile.email}
              {agent && (
                <span className="ml-2 inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 font-mono text-[10px] text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
                  {agent.code}
                </span>
              )}
            </span>
            <Link
              href="/agent/profile"
              className="rounded-md border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              My profile
            </Link>
            <Link
              href="/account/mfa"
              className="rounded-md border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Security
            </Link>
            <form action={signOut}>
              <button className="rounded-md border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800">
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-6 py-10">
        {agent ? (
          <KpiCards agentId={agent.id} />
        ) : (
          <p className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
            Your profile isn&apos;t linked to a selling-agent record yet — contact admin.
          </p>
        )}

        <div className="mt-10 grid gap-4 sm:grid-cols-3">
          <Link
            href="/agent/investors"
            className="rounded-lg border border-emerald-200 bg-white p-5 transition-colors hover:bg-emerald-50 dark:border-emerald-900 dark:bg-zinc-900 dark:hover:bg-zinc-800"
          >
            <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">My investors →</p>
            <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
              Investors I sourced — open any to view their full profile.
            </p>
          </Link>
          <Link
            href="/agent/earnings"
            className="rounded-lg border border-emerald-200 bg-white p-5 transition-colors hover:bg-emerald-50 dark:border-emerald-900 dark:bg-zinc-900 dark:hover:bg-zinc-800"
          >
            <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">My earnings →</p>
            <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
              Live upfront + trail breakdown, per investor.
            </p>
          </Link>
          <Link
            href="/agent/statements"
            className="rounded-lg border border-emerald-200 bg-white p-5 transition-colors hover:bg-emerald-50 dark:border-emerald-900 dark:bg-zinc-900 dark:hover:bg-zinc-800"
          >
            <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Statements →</p>
            <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
              Portfolio, transactions, dividends, tax certificates — PDF.
            </p>
          </Link>
          <Link
            href="/agent/commissions"
            className="rounded-lg border border-emerald-200 bg-white p-5 transition-colors hover:bg-emerald-50 dark:border-emerald-900 dark:bg-zinc-900 dark:hover:bg-zinc-800"
          >
            <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Commissions →</p>
            <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
              Posted upfront, trail, and clawback runs.
            </p>
          </Link>
        </div>
      </div>
    </main>
  );
}

async function KpiCards({ agentId }: { agentId: string }) {
  const k = await loadKpis(agentId);
  const lastPaidLabel = k.lastPaid?.paidOn
    ? `${k.lastPaid.paidOn.toISOString().slice(0, 10)}`
    : "Not paid yet";
  const lastPaidAmount = k.lastPaid?.amount ? formatBdt(Number(k.lastPaid.amount)) : "—";

  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <Card
        label="Initial AUM under my code"
        value={`BDT ${formatBdt(k.initialAum)}`}
        sub="Sum of initial gross amounts at sourcing"
      />
      <Card
        label={`Accrued ${k.quarter.label}`}
        value={`BDT ${formatBdt(k.accruedThisQuarter)}`}
        sub={
          k.accrualSnapshotAt
            ? `Snapshot ${k.accrualSnapshotAt.toISOString().slice(0, 10)}`
            : "Commission runs landing in this calendar quarter"
        }
      />
      <Card label="Last paid run" value={lastPaidLabel} sub={`BDT ${lastPaidAmount}`} />
    </div>
  );
}

function Card({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <p className="text-xs uppercase tracking-wider text-zinc-500">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">{value}</p>
      {sub && <p className="mt-1 text-[11px] text-zinc-500">{sub}</p>}
    </div>
  );
}
