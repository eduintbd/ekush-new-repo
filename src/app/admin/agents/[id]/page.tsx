// /admin/agents/[id] — agent detail. Approve / suspend / reinstate;
// shows editable current terms + history, sourced investors, recent
// commissions, and an inline calculation-methodology panel.

import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { UserRole } from "@/generated/prisma";
import {
  addAgentTerm,
  approveAgent,
  deleteAgent,
  deleteAgentTerm,
  linkInvestorToAgent,
  accrueAgentCommissionAction,
  payAgentCommissionAction,
  postAgentCommissions,
  postAgentUpfront,
  reinstateAgent,
  reinstateAgentUpfront,
  resendAgentInvite,
  setAgentWatermark,
  suspendAgentUpfront,
  suspendAgent,
  unlinkInvestor,
  updateAgentTerm,
} from "@/app/admin/agents/actions";
import { computeAgentCommissionPreview, parseAsOf } from "@/lib/agent-commission-preview";
import { getPayoutState, listAgentPayments } from "@/lib/commission-payout";
import { isBlockingWarning } from "@/lib/upfront-watermark";
import { CommissionBreakdown } from "@/components/commission-breakdown";
import { formatBdt } from "@/lib/format";
import {
  getAllFunds,
  getHoldings,
  getInvestorsByCode,
  getRedemptions,
  listInvestorsForPicker,
  type PortalFund,
  type PortalFundHolding,
  type PortalInvestor,
  type PortalRedemption,
} from "@/lib/portal-data";

type Search = {
  ok?: string;
  error?: string;
  editTerm?: string;
  link?: string;
  /** Billing cut-off (YYYY-MM-DD) the whole commission panel is computed at. */
  asOf?: string;
};

const FUND_CATEGORIES = ["equity", "fixed_income"] as const;

// Same detection the bank-reconciliation page uses to pick cash/bank accounts
// out of the chart of accounts (src/app/bank-reconciliation/new/page.tsx).
const BANK_NAME_PATTERN =
  /(cash|bank|brac|ucb|bkash|nagad|rocket|mtbl|dbbl|ebl|std account|midland|premier|prime|nccb)/i;

/** Default tax deducted at source on agent commission, as a percentage.
 *  Overridable per payout on the form; this is only what the field starts at. */
const DEFAULT_WHT_PCT = Number(process.env.AGENT_COMMISSION_WHT_PCT ?? "10");

export default async function AgentDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Search>;
}) {
  // Accountant can view and can post commission runs; everything else on this
  // page (approve/suspend/delete, terms, investor links) stays admin/checker
  // and is gated per-action in actions.ts.
  const me = await requireRole(["admin", "checker", "accountant"]);
  const isAdmin = me.role === UserRole.admin;
  /** Posting a commission run creates the obligation — accountant only. */
  const canPost = me.role === UserRole.accountant;
  const { id } = await params;
  const sp = await searchParams;

  const agent = await prisma.sellingAgent
    .findUnique({
      where: { id },
      include: {
        terms: { orderBy: { effectiveFrom: "desc" } },
        investors: { orderBy: { sourcedOn: "desc" }, take: 25 },
        commissionRuns: { orderBy: { createdAt: "desc" }, take: 25 },
      },
    })
    .catch(() => null);

  if (!agent) notFound();

  // Enrich agent.investors (xsystem.agent_investors) with portal data
  const linkedInvestorCodes = Array.from(new Set(agent.investors.map((i) => i.investorCode)));
  const [portalInvestorMap, fundMap, portalPicker] = await Promise.all([
    getInvestorsByCode(linkedInvestorCodes).catch(() => new Map<string, PortalInvestor>()),
    getAllFunds().catch(() => new Map<string, PortalFund>()),
    // Cap at 10000 so codes after the first 500 (e.g. BR0001, anything
    // alphabetically after A…) still appear. The portal has ~500 codes
    // today; 10000 covers near-term growth without runaway query cost.
    listInvestorsForPicker(10000).catch(() => [] as PortalInvestor[]),
  ]);
  const holdingPairs = agent.investors
    .map((i) => ({
      investorId: portalInvestorMap.get(i.investorCode)?.id,
      fundId: fundMap.get(i.fundCode)?.id,
    }))
    .filter((p): p is { investorId: string; fundId: string } => !!p.investorId && !!p.fundId);
  const earliestSourced = agent.investors.reduce<Date | null>(
    (acc, l) => (acc === null || l.sourcedOn < acc ? l.sourcedOn : acc),
    null,
  );
  const [holdingMap, redemptionMap] = await Promise.all([
    getHoldings(holdingPairs).catch(() => new Map<string, PortalFundHolding>()),
    getRedemptions(holdingPairs, earliestSourced ?? undefined).catch(
      () => new Map<string, PortalRedemption[]>(),
    ),
  ]);

  // Billing cut-off. Defaults to now; the accountant sets it to the period end
  // (e.g. 2026-07-30) so the figure on screen is the figure being billed, not
  // whatever has accrued by the day they happen to open the page.
  const asOf = parseAsOf(sp.asOf);

  // On-demand commission preview (no DB write). One engine, so the same numbers
  // appear here, in the Excel download, on the agent's own /agent/earnings, and
  // in what gets persisted when the admin clicks "Post these to CommissionRun".
  const preview = await computeAgentCommissionPreview(prisma, agent.id, asOf).catch(() => null);

  // Payout panel inputs. The billing cut-off defaults to the as-of date so the
  // accountant accrues exactly the period they just looked at.
  const billingEnd = new Date(
    Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()),
  );
  const [payoutState, payments, bankAccounts] = await Promise.all([
    getPayoutState(agent.id, billingEnd).catch(() => null),
    listAgentPayments(agent.id).catch(() => []),
    prisma.chartOfAccount
      .findMany({
        where: { isActive: true, normalBalance: "DEBIT" },
        orderBy: { sl: "asc" },
        select: { name: true, category: true },
      })
      .then((rows) =>
        rows.filter(
          (a) => (a.category && /cash|bank/i.test(a.category)) || BANK_NAME_PATTERN.test(a.name),
        ),
      )
      .catch(() => [] as Array<{ name: string; category: string | null }>),
  ]);

  // Filter the picker to exclude investors already linked to this agent
  const alreadyLinkedSet = new Set(agent.investors.map((i) => `${i.investorCode}|${i.fundCode}`));

  const approve = approveAgent.bind(null, agent.id);
  const suspend = suspendAgent.bind(null, agent.id);
  const reinstate = reinstateAgent.bind(null, agent.id);
  const resend = resendAgentInvite.bind(null, agent.id);
  const del = deleteAgent.bind(null, agent.id);

  // Resolve the current (open) term per category for inline edit
  const today = new Date();
  const currentByCategory = new Map(
    FUND_CATEGORIES.map((cat) => [
      cat,
      agent.terms.find(
        (t) =>
          t.fundCategory === cat &&
          t.effectiveFrom <= today &&
          (t.effectiveTo === null || t.effectiveTo > today),
      ) ?? null,
    ]),
  );

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10 dark:bg-zinc-950">
      <div className="mx-auto max-w-5xl space-y-8">
        <div>
          <div className="text-xs uppercase tracking-widest text-zinc-500">
            <Link href="/dashboard" className="hover:text-zinc-700 dark:hover:text-zinc-300">← Dashboard</Link>
            <span className="mx-1.5 text-zinc-400">/</span>
            <Link href="/admin/agents" className="hover:text-zinc-700 dark:hover:text-zinc-300">Agents</Link>
          </div>
          <div className="mt-2 flex items-center justify-between">
            <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
              {agent.fullName}{" "}
              <code className="ml-2 text-base font-mono text-zinc-500">{agent.code}</code>
            </h1>
            <div className="flex items-center gap-2">
              <Link
                href={`/admin/agents/${agent.id}/profile`}
                className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
              >
                Profile &amp; documents
              </Link>
              {agent.status === "pending" && (
                <form action={approve}>
                  <button className="rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-800">
                    Approve
                  </button>
                </form>
              )}
              {agent.status === "approved" && (
                <>
                  <form action={resend}>
                    <button className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800">
                      Resend invite
                    </button>
                  </form>
                  <form action={suspend}>
                    <button className="rounded-md bg-orange-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-orange-700">
                      Suspend
                    </button>
                  </form>
                </>
              )}
              {agent.status === "suspended" && (
                <form action={reinstate}>
                  <button className="rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-800">
                    Reinstate
                  </button>
                </form>
              )}
              {isAdmin && (
                <form
                  action={del}
                  data-confirm={`Permanently delete agent ${agent.code} (${agent.fullName})? This removes all its commission runs, investor links and terms, and unlinks any journals. This cannot be undone.`}
                >
                  <button className="rounded-md border border-red-300 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950">
                    Delete
                  </button>
                </form>
              )}
            </div>
          </div>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            {agent.email}
            {agent.phone && ` · ${agent.phone}`} · status <strong>{agent.status}</strong>
          </p>
        </div>

        {sp.ok && (
          <div className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
            {sp.ok}
          </div>
        )}
        {sp.error && (
          <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
            {sp.error}
          </div>
        )}
        {sp.link && (
          <div className="rounded-md border border-sky-300 bg-sky-50 px-3 py-3 text-sm text-sky-900 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-100">
            <p className="mb-2 font-medium">
              Set-password link — send this to the agent if they don’t receive the email.
            </p>
            <input
              readOnly
              value={sp.link}
              className="w-full select-all rounded border border-sky-300 bg-white px-2 py-1.5 font-mono text-xs text-zinc-800 dark:border-sky-800 dark:bg-zinc-900 dark:text-zinc-200"
            />
            <p className="mt-1.5 text-[11px] text-sky-800/80 dark:text-sky-200/70">
              Click the field to select, then copy. The link is one-time and expires; use
              “Resend invite” to generate a fresh one.
            </p>
          </div>
        )}

        <Section title="Current terms — edit in place">
          {agent.terms.length === 0 ? (
            <p className="text-sm text-zinc-500">
              No terms set. Approve the agent to seed defaults.
            </p>
          ) : (
            <div className="space-y-4">
              {FUND_CATEGORIES.map((cat) => {
                const t = currentByCategory.get(cat);
                if (!t) {
                  return (
                    <p key={cat} className="text-sm text-zinc-500">
                      No active <strong>{cat}</strong> term — add one below.
                    </p>
                  );
                }
                return (
                  <form
                    key={t.id}
                    action={updateAgentTerm}
                    className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800"
                  >
                    <input type="hidden" name="id" value={t.id} />
                    <input type="hidden" name="agentId" value={agent.id} />
                    <div className="mb-2 flex items-center justify-between">
                      <div className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
                        {cat.replace("_", " ")}
                      </div>
                      <div className="text-[10px] text-zinc-500">
                        effective {t.effectiveFrom.toISOString().slice(0, 10)} → now
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-6">
                      <PctInput
                        name="upfrontPct"
                        label="Upfront %"
                        defaultValue={(Number(t.upfrontPct) * 100).toFixed(4)}
                      />
                      <PctInput
                        name="trailY1PctPa"
                        label="Trail Y1 p.a. %"
                        defaultValue={(Number(t.trailY1PctPa) * 100).toFixed(4)}
                      />
                      <PctInput
                        name="trailY2PlusPctPa"
                        label="Trail Y2+ p.a. %"
                        defaultValue={(Number(t.trailY2PlusPctPa) * 100).toFixed(4)}
                      />
                      <label className="block">
                        <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
                          Trail frequency
                        </span>
                        <select
                          name="trailFrequency"
                          defaultValue={t.trailFrequency === "quarterly" ? "quarterly" : "monthly"}
                          className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
                        >
                          <option value="monthly">Monthly</option>
                          <option value="quarterly">Quarterly</option>
                        </select>
                      </label>
                      <label className="block">
                        <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
                          Clawback months
                        </span>
                        <input
                          type="number"
                          name="clawbackMonths"
                          min={0}
                          defaultValue={t.clawbackMonths}
                          className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1 font-mono tabular-nums dark:border-zinc-700 dark:bg-zinc-900"
                        />
                      </label>
                      <PctInput
                        name="clawbackPct"
                        label="Clawback %"
                        defaultValue={(Number(t.clawbackPct) * 100).toFixed(2)}
                      />
                    </div>
                    <div className="mt-2 flex items-center justify-end">
                      <button
                        type="submit"
                        className="rounded-md bg-zinc-900 px-3 py-1 text-xs font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
                      >
                        Save {cat.replace("_", " ")}
                      </button>
                    </div>
                  </form>
                );
              })}
            </div>
          )}

          {/* Add new term form — supersedes the current open term for the chosen category */}
          <details className="mt-4 rounded-md border border-dashed border-zinc-300 dark:border-zinc-700">
            <summary className="cursor-pointer px-3 py-2 text-xs font-semibold uppercase tracking-wider text-zinc-500 hover:bg-zinc-50 dark:hover:bg-zinc-950">
              + Add new term (introduce new effective period)
            </summary>
            <form action={addAgentTerm} className="grid grid-cols-2 gap-2 p-3 text-xs sm:grid-cols-6">
              <input type="hidden" name="agentId" value={agent.id} />
              <label className="block">
                <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
                  Fund category
                </span>
                <select
                  name="fundCategory"
                  required
                  className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
                >
                  {FUND_CATEGORIES.map((c) => (<option key={c} value={c}>{c.replace("_", " ")}</option>))}
                </select>
              </label>
              <PctInput name="upfrontPct" label="Upfront %" defaultValue="0.20" required />
              <PctInput name="trailY1PctPa" label="Trail Y1 %" defaultValue="0.40" required />
              <PctInput name="trailY2PlusPctPa" label="Trail Y2+ %" defaultValue="0.35" required />
              <label className="block">
                <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
                  Trail frequency
                </span>
                <select
                  name="trailFrequency"
                  defaultValue="monthly"
                  className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
                >
                  <option value="monthly">Monthly</option>
                  <option value="quarterly">Quarterly</option>
                </select>
              </label>
              <label className="block">
                <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
                  Clawback months
                </span>
                <input
                  type="number"
                  name="clawbackMonths"
                  min={0}
                  defaultValue={6}
                  className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1 font-mono tabular-nums dark:border-zinc-700 dark:bg-zinc-900"
                />
              </label>
              <PctInput name="clawbackPct" label="Clawback %" defaultValue="100" required />
              <label className="col-span-2 block">
                <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
                  Effective from
                </span>
                <input
                  type="date"
                  name="effectiveFrom"
                  required
                  className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
                />
              </label>
              <div className="col-span-2 mt-2 flex items-end justify-end sm:col-span-6">
                <button
                  type="submit"
                  className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
                >
                  Save new term
                </button>
              </div>
            </form>
          </details>
        </Section>

        <Section title="Terms history">
          {agent.terms.length === 0 ? (
            <p className="text-sm text-zinc-500">No terms set.</p>
          ) : (
            <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
              <thead className="text-left text-[11px] uppercase tracking-wider text-zinc-500">
                <tr>
                  <th className="py-2 pr-4">Category</th>
                  <th className="py-2 pr-4">Upfront</th>
                  <th className="py-2 pr-4">Trail Y1 p.a.</th>
                  <th className="py-2 pr-4">Trail Y2+ p.a.</th>
                  <th className="py-2 pr-4">Clawback</th>
                  <th className="py-2 pr-4">Effective</th>
                  <th className="py-2 pr-4" />
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {agent.terms.map((t) => {
                  const isCurrent = t.effectiveTo === null;
                  const isEditing = sp.editTerm === t.id;
                  if (isEditing) {
                    return (
                      <tr key={t.id} className="bg-amber-50 dark:bg-amber-950/30">
                        <td colSpan={7} className="py-2">
                          <form action={updateAgentTerm} className="flex flex-wrap items-end gap-2 text-xs">
                            <input type="hidden" name="id" value={t.id} />
                            <input type="hidden" name="agentId" value={agent.id} />
                            <label className="block">
                              <span className="block font-medium uppercase tracking-wider text-zinc-500">Category</span>
                              <div className="mt-1 py-1.5 px-2 text-sm">{t.fundCategory}</div>
                            </label>
                            <label className="block">
                              <span className="block font-medium uppercase tracking-wider text-zinc-500">Upfront</span>
                              <input
                                name="upfrontPct"
                                type="number"
                                step="0.0001"
                                defaultValue={Number(t.upfrontPct)}
                                className="mt-1 w-24 rounded-md border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
                              />
                            </label>
                            <label className="block">
                              <span className="block font-medium uppercase tracking-wider text-zinc-500">Y1 p.a.</span>
                              <input
                                name="trailY1PctPa"
                                type="number"
                                step="0.0001"
                                defaultValue={Number(t.trailY1PctPa)}
                                className="mt-1 w-24 rounded-md border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
                              />
                            </label>
                            <label className="block">
                              <span className="block font-medium uppercase tracking-wider text-zinc-500">Y2+ p.a.</span>
                              <input
                                name="trailY2PlusPctPa"
                                type="number"
                                step="0.0001"
                                defaultValue={Number(t.trailY2PlusPctPa)}
                                className="mt-1 w-24 rounded-md border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
                              />
                            </label>
                            <label className="block">
                              <span className="block font-medium uppercase tracking-wider text-zinc-500">Clawback mo</span>
                              <input
                                name="clawbackMonths"
                                type="number"
                                step="1"
                                defaultValue={t.clawbackMonths}
                                className="mt-1 w-20 rounded-md border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
                              />
                            </label>
                            <label className="block">
                              <span className="block font-medium uppercase tracking-wider text-zinc-500">Clawback %</span>
                              <input
                                name="clawbackPct"
                                type="number"
                                step="0.01"
                                defaultValue={Number(t.clawbackPct)}
                                className="mt-1 w-20 rounded-md border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
                              />
                            </label>
                            <label className="block">
                              <span className="block font-medium uppercase tracking-wider text-zinc-500">Frequency</span>
                              <select
                                name="trailFrequency"
                                defaultValue={t.trailFrequency === "quarterly" ? "quarterly" : "monthly"}
                                className="mt-1 w-28 rounded-md border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
                              >
                                <option value="monthly">Monthly</option>
                                <option value="quarterly">Quarterly</option>
                              </select>
                            </label>
                            <div className="flex items-center gap-2">
                              <button
                                type="submit"
                                className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
                              >
                                Save
                              </button>
                              <Link
                                href={`/admin/agents/${agent.id}`}
                                className="text-[11px] text-zinc-500 underline"
                              >
                                Cancel
                              </Link>
                            </div>
                          </form>
                          <p className="mt-1 px-2 text-[10px] text-zinc-500">
                            Tip: enter values as decimals (0.002 = 0.20%) OR as whole percents (0.2 = 0.20%) — the
                            backend treats anything &ge; 1 as a percent literal.
                          </p>
                        </td>
                      </tr>
                    );
                  }
                  return (
                    <tr key={t.id} className={isCurrent ? "" : "text-zinc-400"}>
                      <td className="py-1.5 pr-4">
                        {t.fundCategory}
                        {isCurrent && (
                          <span className="ml-2 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[9px] font-medium uppercase text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                            current
                          </span>
                        )}
                      </td>
                      <td className="py-1.5 pr-4 tabular-nums">{(Number(t.upfrontPct) * 100).toFixed(2)}%</td>
                      <td className="py-1.5 pr-4 tabular-nums">{(Number(t.trailY1PctPa) * 100).toFixed(2)}%</td>
                      <td className="py-1.5 pr-4 tabular-nums">{(Number(t.trailY2PlusPctPa) * 100).toFixed(2)}%</td>
                      <td className="py-1.5 pr-4">
                        {t.clawbackMonths}mo @ {(Number(t.clawbackPct) * 100).toFixed(0)}%
                        <span className="ml-2 rounded-full bg-sky-100 px-1.5 py-0.5 text-[9px] font-medium uppercase text-sky-700 dark:bg-sky-950 dark:text-sky-300">
                          {t.trailFrequency === "quarterly" ? "quarterly trail" : "monthly trail"}
                        </span>
                      </td>
                      <td className="py-1.5 pr-4">
                        {t.effectiveFrom.toISOString().slice(0, 10)} →{" "}
                        {t.effectiveTo ? t.effectiveTo.toISOString().slice(0, 10) : "now"}
                      </td>
                      <td className="py-1.5 pr-4 text-right">
                        <div className="flex items-center gap-3 text-[11px]">
                          <Link
                            href={`/admin/agents/${agent.id}?editTerm=${t.id}`}
                            className="text-zinc-600 underline hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200"
                          >
                            edit
                          </Link>
                          <form
                            action={deleteAgentTerm}
                            className="inline"
                            data-confirm={`Delete this ${t.fundCategory} term effective ${t.effectiveFrom.toISOString().slice(0, 10)}? Commission calculations will use whichever term remains for this category.`}
                          >
                            <input type="hidden" name="id" value={t.id} />
                            <input type="hidden" name="agentId" value={agent.id} />
                            <button
                              type="submit"
                              className="text-red-600 hover:underline dark:text-red-400"
                            >
                              delete
                            </button>
                          </form>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Section>

        <MethodologyPanel />

        <CommissionPreviewPanel
          agentId={agent.id}
          preview={preview}
          asOfParam={sp.asOf ?? ""}
          canPost={canPost}
        />

        <CommissionPayoutPanel
          agentId={agent.id}
          asOfParam={sp.asOf ?? ""}
          billingEnd={billingEnd.toISOString().slice(0, 10)}
          state={payoutState}
          payments={payments}
          bankAccounts={bankAccounts}
        />

        <Section title={`Recent commissions (${agent.commissionRuns.length})`}>
          {agent.commissionRuns.length === 0 ? (
            <p className="text-sm text-zinc-500">No runs yet.</p>
          ) : (
            <table className="min-w-full text-sm">
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {agent.commissionRuns.map((r) => (
                  <tr key={r.id}>
                    <td className="py-1.5 pr-4 text-xs uppercase">{r.type}</td>
                    <td className="py-1.5 pr-4">
                      {r.periodEnd ? r.periodEnd.toISOString().slice(0, 10) : "—"}
                    </td>
                    <td className="py-1.5 pr-4 text-right tabular-nums">{formatBdt(Number(r.amount))}</td>
                    <td className="py-1.5 pr-4 text-xs">{r.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>

        <Section title={`Sourced investors (${agent.investors.length})`}>
          {agent.investors.length === 0 ? (
            <p className="text-sm text-zinc-500">
              No investors linked yet. Use the form below to attach existing portal investors
              to this agent — the commission engine + agent portal will start using them.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
                <thead className="text-left text-[11px] uppercase tracking-wider text-zinc-500">
                  <tr>
                    <th className="py-2 pr-3">Investor code</th>
                    <th className="py-2 pr-3">Name (from portal)</th>
                    <th className="py-2 pr-3">Fund</th>
                    <th className="py-2 pr-3">Sourced</th>
                    <th className="py-2 pr-3 text-right">Initial units</th>
                    <th className="py-2 pr-3 text-right">Current units (live)</th>
                    <th className="py-2 pr-3 text-right">NAV (live)</th>
                    <th className="py-2 pr-3 text-right">Market value</th>
                    <th className="py-2 pr-3 text-right">Redemptions</th>
                    <th className="py-2 pr-3"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {agent.investors.map((i) => {
                    const portal = portalInvestorMap.get(i.investorCode);
                    const fund = fundMap.get(i.fundCode);
                    const key = portal && fund ? `${portal.id}|${fund.id}` : "";
                    const holding = key ? holdingMap.get(key) : undefined;
                    const allReds = key ? (redemptionMap.get(key) ?? []) : [];
                    const reds = allReds.filter((r) => r.date >= i.sourcedOn);
                    const totalRedeemedUnits = reds.reduce((s, r) => s + r.units, 0);
                    const totalRedeemedGross = reds.reduce((s, r) => s + r.gross, 0);
                    return (
                      <tr key={i.id}>
                        <td className="py-1.5 pr-3 font-mono text-xs">{i.investorCode}</td>
                        <td className="py-1.5 pr-3">
                          {portal?.name ?? <span className="text-zinc-400 italic">not in portal</span>}
                          {i.isDirectSubscription && (
                            <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[9px] font-medium uppercase text-amber-800 dark:bg-amber-950 dark:text-amber-200">
                              direct
                            </span>
                          )}
                        </td>
                        <td className="py-1.5 pr-3 text-xs">{i.fundCode}</td>
                        <td className="py-1.5 pr-3 text-xs">{i.sourcedOn.toISOString().slice(0, 10)}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{Number(i.initialUnits).toFixed(2)}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">
                          {holding ? holding.totalCurrentUnits.toFixed(2) : <span className="text-zinc-400">—</span>}
                        </td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">
                          {holding ? holding.nav.toFixed(4) : <span className="text-zinc-400">—</span>}
                        </td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">
                          {holding ? formatBdt(holding.totalMarketValue) : <span className="text-zinc-400">—</span>}
                        </td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">
                          {reds.length === 0 ? (
                            <span className="text-zinc-400">—</span>
                          ) : (
                            <details className="inline-block">
                              <summary className="cursor-pointer text-xs">
                                {reds.length} × {totalRedeemedUnits.toFixed(2)} units
                              </summary>
                              <div className="absolute right-2 z-10 mt-1 rounded-md border border-zinc-300 bg-white p-2 text-left text-[10px] shadow-lg dark:border-zinc-700 dark:bg-zinc-950">
                                <p className="mb-1 font-semibold text-zinc-700 dark:text-zinc-300">
                                  {reds.length} redemption{reds.length === 1 ? "" : "s"} · {totalRedeemedUnits.toFixed(2)} units · {formatBdt(totalRedeemedGross)}
                                </p>
                                <ul className="space-y-0.5">
                                  {reds.map((r, idx) => (
                                    <li key={idx} className="font-mono">
                                      {r.date.toISOString().slice(0, 10)} · {r.units.toFixed(2)} units · {formatBdt(r.gross)} ({r.channel})
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            </details>
                          )}
                        </td>
                        <td className="py-1.5 pr-3 text-right">
                          <form
                            action={unlinkInvestor}
                            className="inline"
                            data-confirm={`Unlink investor ${i.investorCode} from this agent? Trail commissions will stop accruing.`}
                          >
                            <input type="hidden" name="id" value={i.id} />
                            <input type="hidden" name="agentId" value={agent.id} />
                            <button
                              type="submit"
                              className="text-[10px] text-red-600 hover:underline dark:text-red-400"
                            >
                              unlink
                            </button>
                          </form>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Link a new investor */}
          <details className="mt-4 rounded-md border border-dashed border-zinc-300 dark:border-zinc-700">
            <summary className="cursor-pointer px-3 py-2 text-xs font-semibold uppercase tracking-wider text-zinc-500 hover:bg-zinc-50 dark:hover:bg-zinc-950">
              + Link investor to this agent ({portalPicker.length} investors in portal)
            </summary>
            <form action={linkInvestorToAgent} className="grid grid-cols-2 gap-3 p-3 text-xs sm:grid-cols-3">
              <input type="hidden" name="agentId" value={agent.id} />
              <label className="col-span-2 block">
                <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
                  Investor *
                </span>
                <select
                  name="investorCode"
                  required
                  className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 font-mono dark:border-zinc-700 dark:bg-zinc-900"
                >
                  <option value="">— pick an investor —</option>
                  {portalPicker.map((inv) => (
                    <option key={inv.id} value={inv.investorCode ?? ""}>
                      {inv.investorCode} · {inv.name ?? "(no name)"} · {inv.investorType ?? "—"}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
                  Fund *
                </span>
                <select
                  name="fundCode"
                  required
                  className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-900"
                >
                  <option value="">—</option>
                  <option value="EFUF">EFUF — Ekush First Unit Fund</option>
                  <option value="EGF">EGF — Ekush Growth Fund</option>
                  <option value="ESRF">ESRF — Ekush Stable Return Fund</option>
                </select>
              </label>
              <label className="block">
                <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
                  Sourced on *
                </span>
                <input
                  type="date"
                  name="sourcedOn"
                  required
                  className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-900"
                />
              </label>
              <label className="block">
                <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
                  Initial units *
                </span>
                <input
                  type="number"
                  step="0.0001"
                  name="initialUnits"
                  required
                  className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 font-mono dark:border-zinc-700 dark:bg-zinc-900"
                />
              </label>
              <label className="block">
                <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
                  Unit price at sourcing *
                </span>
                <input
                  type="number"
                  step="0.0001"
                  name="unitPriceAtSourcing"
                  required
                  className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 font-mono dark:border-zinc-700 dark:bg-zinc-900"
                />
              </label>
              <label className="block">
                <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
                  Initial gross amount (optional — auto if blank)
                </span>
                <input
                  type="number"
                  step="0.01"
                  name="initialGrossAmount"
                  className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 font-mono dark:border-zinc-700 dark:bg-zinc-900"
                />
              </label>
              <label className="col-span-2 flex items-center gap-2 text-xs sm:col-span-2">
                <input type="checkbox" name="isDirectSubscription" className="rounded border-zinc-400" />
                <span>Direct subscription (no agent commission per clause 6.5)</span>
              </label>
              <div className="col-span-2 mt-2 flex items-end justify-end sm:col-span-3">
                <button
                  type="submit"
                  className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
                >
                  Link investor
                </button>
              </div>
            </form>
          </details>

          <p className="mt-3 text-[10px] text-zinc-500">
            Live data — current units, NAV, market value — comes from the portal's
            <code className="mx-1 font-mono">public.fund_holdings</code> table. The agent ↔ investor
            link is stored in <code className="font-mono">xsystem.agent_investors</code>; the
            portal isn't aware of which agent sourced which investor.
            <br />
            <span className="text-zinc-400">
              Already-linked {alreadyLinkedSet.size} link(s) — the picker shows all portal investors;
              same (investor, fund) pair can't be linked twice due to a uniqueness constraint.
            </span>
          </p>
        </Section>
      </div>
    </main>
  );
}

function PctInput({
  name,
  label,
  defaultValue,
  required = false,
}: {
  name: string;
  label: string;
  defaultValue?: string;
  required?: boolean;
}) {
  return (
    <label className="block">
      <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">{label}</span>
      <input
        type="number"
        step="0.0001"
        name={name}
        defaultValue={defaultValue}
        required={required}
        className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1 font-mono tabular-nums dark:border-zinc-700 dark:bg-zinc-900"
      />
    </label>
  );
}

function MethodologyPanel() {
  return (
    <Section title="How agent commissions are calculated" collapsible>
      <p className="text-xs text-zinc-600 dark:text-zinc-400">
        Per the Selling Agent Agreement clause 6. Upfront is implemented in{" "}
        <code className="font-mono">src/lib/upfront-watermark.ts</code> and posted by{" "}
        <code className="font-mono">src/lib/run-upfront.ts</code>; trail in{" "}
        <code className="font-mono">src/lib/agent-commission-preview.ts</code>, posted by{" "}
        <code className="font-mono">src/lib/post-trail.ts</code>. (
        <code className="font-mono">commission-engine.ts</code> is the pre-2026 model, retained
        deprecated with no live callers.) Values stored as decimals (e.g. <code>0.0020</code> for
        0.20%); the form accepts percent literals (<code>0.20</code> → stored as{" "}
        <code>0.0020</code>).
      </p>

      <div className="mt-4 space-y-4 text-sm">
        <Method
          title="① Upfront commission — per-agent BOOK high-water-mark (every investor, all funds combined)"
          formula={
            "net_principal(agent) = Σ across EVERY sourced investor and ALL funds of\n" +
            "                       (BUY − SELL) cash, EXCLUDING CIP reinvestment\n" +
            "watermark(agent) = running peak of net_principal (never falls on redemption,\n" +
            "                   fund switch, or a transfer between the agent's clients)\n" +
            "increment = max(0, new_peak − stored_watermark)\n" +
            "upfront   = increment × upfront_pct of the fund that RECEIVED the money"
          }
          example={
            "Agent BI0000 sources A00123 into ESRF (equity, 0.10%) with 500,000 → book net principal 500,000 (peak) → upfront 0.10% × 500,000 = 500; watermark 500,000. " +
            "A00123 then redeems 200,000 from ESRF and buys 250,000 into EFUF (fixed income, 0.15%). The book moves 500,000 → 300,000 → 550,000. " +
            "The new high is 550,000, i.e. 50,000 above the watermark — and the money that set it went into EFUF, so EFUF's rate applies: 50,000 × 0.15% = 75; watermark → 550,000. " +
            "Now a DIFFERENT investor, A00456, subscribes 200,000 on the same day A00123 redeems 200,000. The book is unchanged, so there is no new high and no upfront — under the old per-investor model A00456 looked like a brand-new client and paid in full on money that never left the agent's book."
          }
          notes={[
            "Per agent — ONE watermark spanning every investor they sourced and EGF, ESRF and EFUF together. Money moving between funds, or between two of this agent's own clients, is not new money and earns nothing.",
            "The cost is deliberate: a genuinely new client whose money arrives while another client is redeeming earns nothing, because the book has not made a new high. A book peak can never exceed the sum of the individual peaks, so this model pays the same or less than the one it replaced — the right direction of error given there is no clawback.",
            "CIP dividend reinvestment is excluded from net principal — a reinvested dividend is not money the agent brought in, so it never lifts the watermark.",
            "Rate attribution: the increment is charged at the category rate of the fund that received the money setting the new high. If two funds or two investors set the high in one evaluation, the increment splits and each part carries its own fund's rate — the Rate column then shows a blended figure; expand the row for the split.",
            "The watermark ratchets up only; redemptions/NAV moves never reduce it and never earn upfront — only net-new principal above the prior peak does.",
            "Skipped if `is_direct_subscription = true` (clause 6.5 — no agent commission on direct subscriptions).",
            "A blocking data warning, or a fund with no active term, now blocks the WHOLE agent rather than one investor — the book is a single series, so dropping one investor's rows would stop their SELLs cancelling and overstate everyone else.",
            "WHO POSTS: the accountant, and only the accountant. `/api/cron/monthly-upfront` evaluates on the 1st and REPORTS what is due — it does not write. The accountant sets the billing cut-off above and clicks 'Post upfront now', which attributes the rows to them in the audit log. Posted as one CommissionRun per driving investor × fund (type=upfront, fund_code = the fund whose rate applied, agent_investor_id set).",
            "Changed 2026-08 from a per-(agent, investor) watermark, which was itself a 2026-07 change from per-(agent, fund). Posted upfront exists under the previous model and was restated by scripts/restate-global-watermark.ts.",
          ]}
        />

        <Method
          title="② Trail commission — paid monthly or quarterly on weekly average holding value"
          formula={
            "weekly_value(week) = units_outstanding_at_week × unit_nav_at_week\n" +
            "avg = mean(weekly_value over the period)\n" +
            "amount = avg × (rate_pa ÷ periods_per_year)   // 12 monthly, 4 quarterly"
          }
          example={
            "Cadence is set per term (Trail frequency — monthly is the default). Investor sourced 2025-08-12, " +
            "monthly term: period 2026-02-01 → 2026-02-28. Period midpoint < sourced_on + 12 months (2026-08-12), so Trail Y1 applies. " +
            "With weekly NAVs each Thursday × outstanding units, avg ≈ BDT 1.2M. Trail Y1 0.40% p.a. → 0.40% ÷ 12 = 0.0333% monthly. " +
            "Trail = 1,200,000 × 0.000333 ≈ BDT 400 (≈ BDT 1,200 over the quarter, same as the quarterly cadence)."
          }
          notes={[
            "Cadence per term via Trail frequency (monthly default / quarterly). One monthly evaluation serves both: a quarterly term stays 'partial' until its quarter closes, so it cannot be paid twice.",
            "Rate tier switches at exactly `sourced_on + 12 months`. Periods straddling the boundary use Y1 if the midpoint is before, Y2+ if after.",
            "Redeemed units stop earning trail from the redemption date (clause 6.3) — `units_at_week` re-computes per week.",
            "Monthly = strict calendar month; quarterly = strict 3-calendar-month window (Jul-Sep, Oct-Dec, Jan-Mar, Apr-Jun).",
            "WHO POSTS: the accountant. `/api/cron/monthly-trail` runs 03:00 UTC on the 1st and REPORTS every completed, unposted period — it does not write. Nothing is lost if a month is missed; the next report still shows it.",
            "If no weekly NAV snapshots exist for the fund in the period, the run is skipped (cannot compute average).",
            "When switching a term's cadence, change it at a period boundary — a mid-quarter switch can pay both the quarter and its months.",
          ]}
        />

        <Method
          title="③ Clawback — NOT IMPLEMENTED; the watermark makes it unnecessary"
          formula={
            "no clawback rows are generated by any code path\n" +
            "the equivalent effect: a redemption lowers net_principal but NOT the peak,\n" +
            "so the money must be brought back before upfront is earned again"
          }
          example={
            "An investor redeems 200,000 the month after their upfront was paid. No negative row is written. " +
            "Instead the book falls 200,000 below its peak, and the agent's next 200,000 of new money — from that investor or any other — earns nothing, because it sets no new high. " +
            "The upfront is recovered by suppression rather than by a debit."
          }
          notes={[
            "Posting a clawback ON TOP of the watermark would charge twice for one redemption. Example: upfront BDT 1,000 paid on 10,00,000 at 0.10%; the client redeems 3,00,000. The watermark already forfeits the next BDT 300 the agent would have earned (they must replace the 3,00,000 before earning again). A 100% clawback would ALSO debit BDT 300 now. Same event, recovered twice.",
            "The `clawback_months` / `clawback_pct` fields on a term are still stored and editable — they record what the agreement says — but nothing reads them for posting, and nothing should while the watermark is the upfront model.",
            "Known gap, accepted deliberately: the watermark suppresses FUTURE upfront, it does not recover cash already paid. An agent who takes an upfront and never brings new money again is never clawed back. Recovering that would need a real clawback AND the suppression switched off for the same redemption — a separate decision, not a default.",
            "`CommissionType.clawback` exists in the schema and no code writes it.",
            "This is also why the book-level watermark is deliberately conservative: underpaying is correctable by paying later, overpaying is not correctable at all.",
          ]}
        />
      </div>

      <p className="mt-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
        Terms can change over time — each AgentTerm row stamps an{" "}
        <code className="font-mono">effective_from / effective_to</code> window. The two components
        pick a term differently, and deliberately:{" "}
        <strong>upfront</strong> uses the term in force on the billing cut-off above (the same{" "}
        <code className="font-mono">makeRateResolver</code> the posting run uses, so the screen
        cannot quote a rate that would not be posted), while <strong>trail</strong> applies the
        latest term per category across all periods. Not the sourcing date — that was the
        pre-2026 model. Older terms remain in place for historical commissions.
      </p>
    </Section>
  );
}

function Method({
  title,
  formula,
  example,
  notes,
}: {
  title: string;
  formula: string;
  example: string;
  notes: string[];
}) {
  return (
    <article className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
      <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">{title}</h3>
      <pre className="mt-2 overflow-x-auto rounded bg-zinc-50 p-2 font-mono text-[11px] text-zinc-800 dark:bg-zinc-950 dark:text-zinc-200">
{formula}
      </pre>
      <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
        <strong>Worked example: </strong>
        {example}
      </p>
      <ul className="mt-2 list-inside list-disc space-y-0.5 text-[11px] text-zinc-600 dark:text-zinc-400">
        {notes.map((n, i) => (
          <li key={i}>{n}</li>
        ))}
      </ul>
    </article>
  );
}

function CommissionPreviewPanel({
  agentId,
  preview,
  asOfParam,
  canPost,
}: {
  agentId: string;
  preview: Awaited<ReturnType<typeof computeAgentCommissionPreview>> | null;
  /** Raw ?asOf= as typed in the URL — "" when the page is on "today". */
  asOfParam: string;
  /** Viewer is the accountant. The server action refuses anyone else anyway;
   *  hiding the buttons stops the rest of the office trying. */
  canPost: boolean;
}) {
  if (!preview) {
    return (
      <Section title="Calculate as of">
        <p className="text-sm text-red-700 dark:text-red-300">
          Preview failed — see server logs. The portal database may be unreachable.
        </p>
      </Section>
    );
  }
  if (preview.buckets.length === 0) {
    return (
      <Section title="Calculate as of">
        <p className="text-sm text-zinc-500">
          No transactions yet for any linked investor. Link investors below — once they
          execute BUYs in the portal, the preview will populate.
        </p>
      </Section>
    );
  }
  const partialCount = preview.trailRows.filter((r) => r.partial).length;
  const today = preview.asOf.toISOString().slice(0, 10);
  // Everything below — the stat cards, the watermark, the trail rows, the Excel
  // download and both post buttons — is computed at THIS date. Keeping one
  // variable is what stops the screen and the posted rows from disagreeing.
  const asOfQs = asOfParam ? `?asOf=${encodeURIComponent(asOfParam)}` : "";
  const backdated = asOfParam !== "";
  // runUpfront refuses to post for the whole agent on these, so the button must
  // refuse too — clicking into a silent no-op is how an accountant comes to
  // believe an agent was paid when nothing happened.
  const blockingWarnings = preview.upfrontWarnings.filter(isBlockingWarning);
  const upfrontBlocked = blockingWarnings.length > 0;
  return (
    <Section title={`Calculate as of — ${today}`}>
      <form method="GET" className="mb-4 flex flex-wrap items-end gap-2">
        <label className="block">
          <span className="block text-[10px] uppercase tracking-wider text-zinc-500">
            Billing cut-off
          </span>
          <input
            type="date"
            name="asOf"
            defaultValue={asOfParam}
            max={new Date().toISOString().slice(0, 10)}
            className="mt-1 rounded-md border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
          />
        </label>
        <button className="rounded-md border border-zinc-300 px-3 py-1 text-xs font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">
          Recalculate
        </button>
        {backdated && (
          <a
            href={`/admin/agents/${agentId}`}
            className="text-[11px] text-zinc-500 underline hover:text-zinc-700 dark:hover:text-zinc-300"
          >
            back to today
          </a>
        )}
        <span className="text-[11px] text-zinc-500">
          {backdated
            ? `Every figure below is as of the close of ${today} — trades after that date are excluded, and the Post/Accrue buttons use the same date.`
            : "Set the period end (e.g. 2026-07-30) to bill a closed month rather than today."}
        </span>
      </form>
      <CommissionBreakdown
        preview={preview}
        audience="admin"
        entitlementControls={
          <>
            <form
            action={suspendAgentUpfront}
            className="flex flex-wrap items-end gap-2"
            data-confirm="Suspend this agent's upfront from the chosen date? No upfront will be paid while suspended."
          >
            <input type="hidden" name="agentId" value={agentId} />
            <label className="block">
              <span className="block text-[10px] uppercase tracking-wider text-zinc-500">Suspend from</span>
              <input type="date" name="effectiveFrom" required defaultValue={today} className="mt-1 rounded-md border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900" />
            </label>
            <input name="note" placeholder="reason (optional)" className="rounded-md border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900" />
            <button className="rounded-md bg-amber-700 px-3 py-1 font-medium text-white hover:bg-amber-800">Suspend upfront</button>
          </form>
          <form
            action={reinstateAgentUpfront}
            className="flex flex-wrap items-end gap-2"
            data-confirm="Re-instate upfront from the chosen date? Remember to set the book watermark so no back-dated upfront accrues."
          >
            <input type="hidden" name="agentId" value={agentId} />
            <label className="block">
              <span className="block text-[10px] uppercase tracking-wider text-zinc-500">Re-instate from</span>
              <input type="date" name="effectiveFrom" required defaultValue={today} className="mt-1 rounded-md border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900" />
            </label>
            <input name="note" placeholder="reason (optional)" className="rounded-md border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900" />
            <button className="rounded-md bg-zinc-900 px-3 py-1 font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">Re-instate upfront</button>
          </form>
          </>
        }
        watermarkRowAction={(w) => (
          <form
            action={setAgentWatermark}
            className="flex items-center justify-end gap-1"
            data-confirm={`Set this agent's BOOK watermark to the entered value? This is one figure covering every investor they sourced and all three funds. The book's current peak is ${formatBdt(Math.max(w.storedWatermark, w.peak))} — setting BELOW it pays out the difference on the next run; setting AT or ABOVE it pays nothing until the book grows past it.`}
          >
            <input type="hidden" name="agentId" value={agentId} />
            <input
              name="watermark"
              type="number"
              step="0.01"
              min="0"
              defaultValue={Math.max(w.storedWatermark, w.peak).toFixed(2)}
              className="w-28 rounded border border-zinc-300 px-1 py-0.5 text-right tabular-nums dark:border-zinc-700 dark:bg-zinc-900"
            />
            <button className="rounded border border-zinc-300 px-2 py-0.5 text-[10px] font-medium uppercase hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">
              Set
            </button>
          </form>
        )}
        actionBar={
          <>
        <a
          href={`/api/admin/agents/${agentId}/commissions/excel${asOfQs}`}
          className="rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-800"
        >
          Download Excel workbook
        </a>
        {canPost && (
        <form
          action={postAgentUpfront}
          data-confirm={`Post the watermark upfront as of ${today} (${formatBdt(preview.totals.pendingUpfront)} pending)? Idempotent — re-clicking with no new money posts nothing.`}
        >
          <input type="hidden" name="agentId" value={agentId} />
          <input type="hidden" name="asOf" value={asOfParam} />
          <button
            type="submit"
            disabled={preview.totals.pendingUpfront <= 0 || upfrontBlocked}
            title={
              upfrontBlocked
                ? `Blocked by ${blockingWarnings.length} data warning(s): ${blockingWarnings
                    .map((w) => `${w.investorCode} ${w.kind}`)
                    .join("; ")}. The posting run would refuse this too.`
                : undefined
            }
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"
          >
            Post upfront now
          </button>
        </form>
        )}
        {canPost && (
        <form
          action={postAgentCommissions}
          data-confirm={`Post ${countPostable(preview)} trail row(s) to CommissionRun as of ${today}? Idempotent — duplicates are skipped. Partial periods (cut off at ${today}) are not posted; post again once they close.`}
        >
          <input type="hidden" name="agentId" value={agentId} />
          <input type="hidden" name="asOf" value={asOfParam} />
          <button
            type="submit"
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            Post trail to CommissionRun
          </button>
        </form>
        )}
        {!canPost && (
          <span className="rounded-md border border-zinc-300 px-3 py-1.5 text-[11px] text-zinc-500 dark:border-zinc-700">
            Posting commission runs is the accountant&apos;s to do — the figures above are
            read-only for you.
          </span>
        )}
        {partialCount > 0 && (
          <span className="text-[11px] text-zinc-500">
            {partialCount} partial period row(s) shown but not posted yet — post again once
            they close.
          </span>
        )}
          </>
        }
      />
    </Section>
  );
}

/**
 * Commission payout — the step that turns a computed commission into money.
 *
 * Two buttons and not one because the billing date and the payment date are
 * different days: bill to 30 Jul, transfer on 5 Aug. Accruing on the period end
 * puts the expense in July; paying on the transfer date takes the cash out in
 * August. A single voucher on the payment date would file July's expense in
 * August. See src/lib/commission-payout.ts for the vouchers themselves.
 */
function CommissionPayoutPanel({
  agentId,
  asOfParam,
  billingEnd,
  state,
  payments,
  bankAccounts,
}: {
  agentId: string;
  asOfParam: string;
  billingEnd: string;
  state: Awaited<ReturnType<typeof getPayoutState>> | null;
  payments: Awaited<ReturnType<typeof listAgentPayments>>;
  bankAccounts: Array<{ name: string; category: string | null }>;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const unaccrued = state?.unaccrued.amount ?? 0;
  const unpaid = state?.unpaid.amount ?? 0;
  /** "upfront 2,400.00 · trail 182.93", zero types omitted. */
  const splitOf = (b: { byType: { upfront: number; trail: number; clawback: number } } | undefined) =>
    (
      [
        ["upfront", b?.byType.upfront ?? 0],
        ["trail", b?.byType.trail ?? 0],
        ["clawback", b?.byType.clawback ?? 0],
      ] as const
    )
      .filter(([, v]) => v !== 0)
      .map(([k, v]) => `${k} ${formatBdt(v)}`)
      .join(" · ");

  return (
    <Section title="Commission payout — accrue, then pay">
      <p className="text-xs text-zinc-600 dark:text-zinc-400">
        Billing date and payment date are not the same day. Step 1 books the expense on the
        period end; step 2 books the cash on the day the transfer actually leaves. Both are
        idempotent — running either twice does nothing the second time.
      </p>

      {!state && (
        <p className="mt-3 text-sm text-red-700 dark:text-red-300">
          Could not read the payout state — see server logs.
        </p>
      )}

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        {/* Step 1 — accrual */}
        <div className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
            1 · Accrue to the ledger
          </h3>
          <p className="mt-1 text-[11px] text-zinc-500">
            Dr Selling agent fees / Cr Liab-Selling Agent Commission, dated the period end.
            Sweeps every posted commission run ending on or before that date —{" "}
            <strong>upfront and trail together, in one voucher</strong>. There is no separate
            upfront button; one period is one obligation.
          </p>
          <p className="mt-2 text-sm">
            Waiting to be accrued:{" "}
            <strong className="tabular-nums">{formatBdt(unaccrued)}</strong>
            <span className="ml-1 text-[11px] text-zinc-500">
              ({state?.unaccrued.runs ?? 0} run(s) up to {billingEnd})
            </span>
          </p>
          {unaccrued !== 0 && (
            <p className="text-[11px] text-zinc-500">{splitOf(state?.unaccrued)}</p>
          )}
          <form
            action={accrueAgentCommissionAction}
            className="mt-3 flex flex-wrap items-end gap-2"
            data-confirm={`Post the accrual voucher dated the billing period end for ${formatBdt(unaccrued)} (${splitOf(state?.unaccrued) || "nothing"})? One voucher covers upfront and trail together. This books the expense in that period, not today.`}
          >
            <input type="hidden" name="agentId" value={agentId} />
            <input type="hidden" name="asOf" value={asOfParam} />
            <label className="block">
              <span className="block text-[10px] uppercase tracking-wider text-zinc-500">
                Billing period end
              </span>
              <input
                type="date"
                name="billingEnd"
                required
                defaultValue={billingEnd}
                className="mt-1 rounded-md border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
              />
            </label>
            <button
              type="submit"
              disabled={unaccrued <= 0}
              className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"
            >
              Accrue commission
            </button>
          </form>
          {unaccrued <= 0 && (
            <p className="mt-2 text-[11px] text-zinc-500">
              Nothing un-accrued up to {billingEnd}. Post the upfront and trail runs above
              first if the period has not been computed yet.
            </p>
          )}
        </div>

        {/* Step 2 — payment */}
        <div className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
            2 · Pay by bank transfer
          </h3>
          <p className="mt-1 text-[11px] text-zinc-500">
            Dr the payable / Cr bank (net) / Cr AIT &amp; VAT Payble (withheld), dated the day
            the money left. Only settles what step 1 has already accrued.
          </p>
          <p className="mt-2 text-sm">
            Accrued and unpaid:{" "}
            <strong className="tabular-nums">{formatBdt(unpaid)}</strong>
            <span className="ml-1 text-[11px] text-zinc-500">
              ({state?.unpaid.runs ?? 0} run(s))
            </span>
          </p>
          {unpaid !== 0 && <p className="text-[11px] text-zinc-500">{splitOf(state?.unpaid)}</p>}
          <form
            action={payAgentCommissionAction}
            className="mt-3 space-y-2"
            data-confirm={`Post the payment voucher for the gross accrued ${formatBdt(unpaid)}, less withholding? This records that the money has left the bank.`}
          >
            <input type="hidden" name="agentId" value={agentId} />
            <input type="hidden" name="asOf" value={asOfParam} />
            <input type="hidden" name="billingEnd" value={billingEnd} />
            <div className="flex flex-wrap items-end gap-2">
              <label className="block">
                <span className="block text-[10px] uppercase tracking-wider text-zinc-500">
                  Paid on
                </span>
                <input
                  type="date"
                  name="paidOn"
                  required
                  min={billingEnd}
                  defaultValue={today}
                  className="mt-1 rounded-md border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
                />
              </label>
              <label className="block">
                <span className="block text-[10px] uppercase tracking-wider text-zinc-500">
                  Withholding %
                </span>
                <input
                  type="number"
                  name="withholdingPct"
                  step="0.01"
                  min="0"
                  max="99.99"
                  defaultValue={DEFAULT_WHT_PCT}
                  className="mt-1 w-24 rounded-md border border-zinc-300 px-2 py-1 text-right tabular-nums dark:border-zinc-700 dark:bg-zinc-900"
                />
              </label>
            </div>
            <label className="block">
              <span className="block text-[10px] uppercase tracking-wider text-zinc-500">
                From bank account
              </span>
              <select
                name="bankAccountName"
                required
                className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              >
                <option value="">— pick an account —</option>
                {bankAccounts.map((a) => (
                  <option key={a.name} value={a.name}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="submit"
              disabled={unpaid <= 0 || bankAccounts.length === 0}
              className="rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40 hover:bg-emerald-800"
            >
              Record payment
            </button>
          </form>
          {unpaid > 0 && (
            <p className="mt-2 text-[11px] text-zinc-500">
              At {DEFAULT_WHT_PCT}% the agent receives{" "}
              {formatBdt(Math.round(unpaid * (1 - DEFAULT_WHT_PCT / 100) * 100) / 100)} and{" "}
              {formatBdt(Math.round(unpaid * (DEFAULT_WHT_PCT / 100) * 100) / 100)} is withheld.
            </p>
          )}
        </div>
      </div>

      {/* History */}
      <h3 className="mt-6 text-xs font-semibold uppercase tracking-wider text-zinc-500">
        Payments ({payments.length})
      </h3>
      {payments.length === 0 ? (
        <p className="mt-2 text-sm text-zinc-500">No commission has been paid to this agent yet.</p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
            <thead className="text-left text-[11px] uppercase tracking-wider text-zinc-500">
              <tr>
                <th className="py-2 pr-3">Period to</th>
                <th className="py-2 pr-3">Paid on</th>
                <th className="py-2 pr-3 text-right">Upfront</th>
                <th className="py-2 pr-3 text-right">Trail</th>
                <th className="py-2 pr-3 text-right">Gross</th>
                <th className="py-2 pr-3 text-right">Withheld</th>
                <th className="py-2 pr-3 text-right">Net paid</th>
                <th className="py-2 pr-3">Bank</th>
                <th className="py-2 pr-3">Vouchers</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {payments.map((p) => (
                <tr key={p.id}>
                  <td className="py-1.5 pr-3 text-xs">{p.periodEnd}</td>
                  <td className="py-1.5 pr-3 text-xs">{p.paidOn}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{formatBdt(p.upfront)}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{formatBdt(p.trail)}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{formatBdt(p.gross)}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">
                    {formatBdt(p.withholding)}
                  </td>
                  <td className="py-1.5 pr-3 text-right font-semibold tabular-nums">
                    {formatBdt(p.net)}
                  </td>
                  <td className="py-1.5 pr-3 text-xs">{p.bankAccountName}</td>
                  <td className="py-1.5 pr-3 text-xs">
                    {p.accrualBatchId && (
                      <Link
                        href={`/journals/voucher/${p.accrualBatchId}`}
                        className="underline hover:text-zinc-900 dark:hover:text-zinc-100"
                      >
                        accrual
                      </Link>
                    )}
                    {p.accrualBatchId && " · "}
                    <Link
                      href={`/journals/voucher/${p.paymentBatchId}`}
                      className="underline hover:text-zinc-900 dark:hover:text-zinc-100"
                    >
                      payment
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

function countPostable(
  preview: Awaited<ReturnType<typeof computeAgentCommissionPreview>>,
): number {
  // Trail only — upfront is posted via the watermark path (postAgentUpfront).
  return preview.trailRows.filter((r) => !r.partial).length;
}

function Section({
  title,
  children,
  collapsible = false,
}: {
  title: string;
  children: React.ReactNode;
  /** Render closed, opening on click. Uses <details> rather than useState so
   *  this stays a server component — and because globals.css force-expands
   *  <details> when printing, so collapsed content still appears on paper. */
  collapsible?: boolean;
}) {
  if (collapsible) {
    return (
      <section>
        <details className="group">
          <summary className="mb-3 flex cursor-pointer list-none items-center gap-1.5 text-sm font-semibold uppercase tracking-wider text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 [&::-webkit-details-marker]:hidden">
            <span className="inline-block w-3 text-[11px] transition-transform group-open:rotate-45">
              +
            </span>
            {title}
          </summary>
          <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            {children}
          </div>
        </details>
      </section>
    );
  }
  return (
    <section>
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-500">{title}</h2>
      <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        {children}
      </div>
    </section>
  );
}
