// /dashboard — staff portal landing (spec §6.1). Quick links to the
// staff-facing pages. The FY summary card / journals last-10 / alert
// tiles called for in the spec are a follow-up; the underlying pages
// each render their own status on entry.

import Link from "next/link";
import { requireStaff } from "@/lib/auth";
import { signOut } from "@/app/login/actions";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";
import { getMfaStatus, hasVerifiedFactor, mfaRequiredForRole } from "@/lib/mfa";

export default async function DashboardPage() {
  const profile = await requireStaff();
  const supabase = await createSupabaseServerClient();
  const mfa = await getMfaStatus(supabase);
  const mfaEnrolled = hasVerifiedFactor(mfa);
  const mfaRequired = mfaRequiredForRole(profile.role);
  const currentFy = await prisma.fiscalYear
    .findFirst({ where: { isClosed: false }, orderBy: { startsOn: "desc" }, select: { id: true, label: true } })
    .catch(() => null);

  return (
    <main className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <header className="border-b border-zinc-200 bg-white px-6 py-4 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mx-auto flex max-w-6xl items-center justify-between">
          <div>
            <p className="text-xs uppercase tracking-widest text-zinc-500">Staff portal</p>
            <h1 className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
              Dashboard
            </h1>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-zinc-600 dark:text-zinc-400">
              {profile.fullName ?? profile.email}{" "}
              <span className="ml-2 inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                {profile.role}
              </span>
            </span>
            {currentFy && (
              <a
                href={`/api/exports/year-end?fiscalYearId=${currentFy.id}`}
                className="rounded-md border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                title={`Download ${currentFy.label} workbook (CoA / Journals / TB-C / IS / BS / CE / Notes / Annexure)`}
              >
                ⬇ Export {currentFy.label}.xlsx
              </a>
            )}
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
        {!mfaEnrolled && (mfaRequired ? (
          <div className="mb-6 rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
            <span className="font-medium">Two-factor authentication is required for your role.</span>{" "}
            <Link href="/account/mfa" className="underline">Enrol now</Link> — sign-in will start prompting on next session.
          </div>
        ) : (
          <div className="mb-6 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
            Two-factor authentication recommended. <Link href="/account/mfa" className="underline">Enrol now</Link>.
          </div>
        ))}
        <p className="text-sm text-zinc-600 dark:text-zinc-400">Quick links.</p>
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <NavCard href="/trial-balance" title="Trial Balance" desc="Per-account net debit / net credit for the selected fiscal year." />
          <NavCard href="/journals" title="Journals" desc="Browse and enter compound journal entries." />
          <NavCard href="/day-book" title="Day Book" desc="All vouchers in a date range, grouped by date." />
          <NavCard href="/ledger" title="Ledgers" desc="Per-account ledger card with running balance." />
          <NavCard href="/trades" title="Trades" desc="Buy/sell ledger. Each entry auto-posts a journal voucher (BV / SV)." />
          <NavCard href="/portfolio" title="Portfolio" desc="Live holdings, market value, unrealised G/L. Revalue-to-market posts FVTPL journal." />
          <NavCard href="/prices" title="Prices" desc="Enter close prices for the ~12 active instruments. Powers the Portfolio page." />
          <NavCard href="/cash-book" title="Cash &amp; Bank Book" desc="Closing balance for every bank, cash and mobile-money account." />
          <NavCard href="/balance-sheet" title="Balance Sheet" desc="Statement of Financial Position." />
          <NavCard href="/income-statement" title="Income Statement" desc="P&L + OCI." />
          <NavCard href="/changes-in-equity" title="Changes in Equity" desc="Rollforward of paid-up capital, fair value reserve, retained earnings." />
          <NavCard href="/cash-flow" title="Cash Flow" desc="Cash inflow/outflow by counter-account category for the period." />
          <NavCard href="/bank-reconciliation" title="Bank Reconciliation" desc="Per-account book vs statement balance comparison." />
          <NavCard href="/management-fees" title="Management Fees" desc="Cross-verify fund FIN_STATS mgmt-fee imports; manual edit." />
          {(profile.role === "admin" || profile.role === "auditor") && (
            <NavCard href="/admin/audit" title="Audit Log" desc="Trigger-fed mutations on journals, agents, commission runs, fiscal years." />
          )}
          {profile.role === "admin" && (
            <>
              <NavCard
                href="/admin/accounts"
                title="Chart of accounts"
                desc="Add, rename, deactivate ledger accounts. 132 seeded; extend as needed."
              />
              <NavCard
                href="/admin/groups"
                title="Account groups"
                desc="Hierarchical group tree (Asset / Liability / Equity / Income / Expense) with rollup."
              />
              <NavCard
                href="/admin/banks"
                title="Bank account master"
                desc="Structured bank metadata: account no, IFSC, opening balance, BRS start date."
              />
              <NavCard
                href="/admin/brokers"
                title="Brokers"
                desc="Panel of brokers (UCB / Prime Bank). Each links to its BO ledger + margin-loan account in the CoA."
              />
              <NavCard
                href="/admin/opening-balances"
                title="Opening balances"
                desc="Per-FY editor for AccountOpeningBalance. Seed at year-start or via roll-forward."
              />
              <NavCard
                href="/admin/fiscal-years"
                title="Fiscal years"
                desc="Create, close, reopen, and roll-forward closing balances to next year."
              />
            </>
          )}
          <NavCard href="/admin/agents" title="Selling agents" desc="Approve, suspend, manage terms history." />
        </div>
      </div>
    </main>
  );
}

function NavCard({
  href,
  title,
  desc,
  disabled = false,
}: {
  href: string;
  title: string;
  desc: string;
  disabled?: boolean;
}) {
  const card = (
    <div
      className={`rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900 ${
        disabled ? "opacity-60" : "transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800"
      }`}
    >
      <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">{title}</p>
      <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">{desc}</p>
    </div>
  );
  return disabled ? card : <Link href={href}>{card}</Link>;
}
