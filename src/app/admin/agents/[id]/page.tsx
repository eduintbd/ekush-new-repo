// /admin/agents/[id] — agent detail. Approve / suspend / reinstate;
// shows editable current terms + history, sourced investors, recent
// commissions, and an inline calculation-methodology panel.

import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  addAgentTerm,
  approveAgent,
  deleteAgentTerm,
  linkInvestorToAgent,
  postAgentCommissions,
  reinstateAgent,
  suspendAgent,
  unlinkInvestor,
  updateAgentTerm,
} from "@/app/admin/agents/actions";
import { computeAgentCommissionPreview } from "@/lib/agent-commission-preview";
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

type Search = { ok?: string; error?: string; editTerm?: string };

const FUND_CATEGORIES = ["equity", "fixed_income"] as const;

export default async function AgentDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Search>;
}) {
  await requireRole(["admin", "checker"]);
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

  // On-demand commission preview (no DB write). Mirrors the
  // scripts/calc-agent-commissions.ts engine — same numbers in the UI,
  // in the Excel download, and what gets persisted if the admin clicks
  // "Post these to CommissionRun".
  const preview = await computeAgentCommissionPreview(prisma, agent.id).catch(() => null);

  // Filter the picker to exclude investors already linked to this agent
  const alreadyLinkedSet = new Set(agent.investors.map((i) => `${i.investorCode}|${i.fundCode}`));

  const approve = approveAgent.bind(null, agent.id);
  const suspend = suspendAgent.bind(null, agent.id);
  const reinstate = reinstateAgent.bind(null, agent.id);

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
              {agent.status === "pending" && (
                <form action={approve}>
                  <button className="rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-800">
                    Approve
                  </button>
                </form>
              )}
              {agent.status === "approved" && (
                <form action={suspend}>
                  <button className="rounded-md bg-orange-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-orange-700">
                    Suspend
                  </button>
                </form>
              )}
              {agent.status === "suspended" && (
                <form action={reinstate}>
                  <button className="rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-800">
                    Reinstate
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

        <CommissionPreviewPanel agentId={agent.id} preview={preview} />

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
    <Section title="How agent commissions are calculated">
      <p className="text-xs text-zinc-600 dark:text-zinc-400">
        Per the Selling Agent Agreement clause 6 — implemented in{" "}
        <code className="font-mono">src/lib/commission-engine.ts</code>. Values stored as decimals
        (e.g. <code>0.0020</code> for 0.20%); the form accepts percent literals (<code>0.20</code> →
        stored as <code>0.0020</code>).
      </p>

      <div className="mt-4 space-y-4 text-sm">
        <Method
          title="① Upfront commission — paid once at investor sourcing"
          formula="amount = initial_units × unit_price_at_sourcing × upfront_pct"
          example="Investor subscribes 10,000 units at BDT 10.50 in EFUF (equity). Term in effect: upfront 0.20%. Upfront = 10,000 × 10.50 × 0.0020 = BDT 210.00"
          notes={[
            "Computed at sourcing time (`sourced_on`). The agent term in effect on that date is locked in.",
            "Skipped if `is_direct_subscription = true` (clause 6.5 — no agent commission on direct subscriptions).",
            "Posted as a single CommissionRun with type=upfront.",
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
            "Cadence per term via Trail frequency (monthly default / quarterly). The two crons never double-pay: each pays only the terms set to its cadence.",
            "Rate tier switches at exactly `sourced_on + 12 months`. Periods straddling the boundary use Y1 if the midpoint is before, Y2+ if after.",
            "Redeemed units stop earning trail from the redemption date (clause 6.3) — `units_at_week` re-computes per week.",
            "Monthly = strict calendar month; quarterly = strict 3-calendar-month window (Jul-Sep, Oct-Dec, Jan-Mar, Apr-Jun).",
            "Cron `/api/cron/monthly-trail` runs 03:00 UTC on the 1st of every month; `/api/cron/quarterly-trail` on the 1st of Jan/Apr/Jul/Oct — each computes the just-completed period.",
            "If no weekly NAV snapshots exist for the fund in the period, the run is skipped (cannot compute average).",
            "When switching a term's cadence, change it at a period boundary — a mid-quarter switch can pay both the quarter and its months.",
          ]}
        />

        <Method
          title="③ Clawback — recovered if investor redeems early"
          formula={
            "applies when: redemption_date ≤ sourced_on + clawback_months\n" +
            "ratio = redeemed_units ÷ initial_units\n" +
            "amount = − upfront_paid × ratio × clawback_pct"
          }
          example={
            "Upfront BDT 210 paid on 10,000 units at sourcing. Clawback window 6 months @ 100%. " +
            "Investor redeems 3,000 units after 4 months → within the window. Ratio = 3,000 ÷ 10,000 = 0.30. " +
            "Clawback = −210 × 0.30 × 1.00 = −BDT 63 (debit on agent's commission ledger)."
          }
          notes={[
            "Negative-amount CommissionRun with type=clawback — reduces the agent's payable.",
            "Multiple redemptions inside the window each generate their own clawback row.",
            "Redemptions after the window have no clawback impact.",
            "Skipped if `is_direct_subscription = true`.",
          ]}
        />
      </div>

      <p className="mt-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
        Terms can change over time — each AgentTerm row stamps an{" "}
        <code className="font-mono">effective_from / effective_to</code> window. The engine picks
        the term whose window contains the relevant date (sourcing for upfront/clawback; quarter
        midpoint for trail). Older terms remain in place for historical commissions.
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
}: {
  agentId: string;
  preview: Awaited<ReturnType<typeof computeAgentCommissionPreview>> | null;
}) {
  if (!preview) {
    return (
      <Section title="Calculate as of today">
        <p className="text-sm text-red-700 dark:text-red-300">
          Preview failed — see server logs. The portal database may be unreachable.
        </p>
      </Section>
    );
  }
  if (preview.buckets.length === 0) {
    return (
      <Section title="Calculate as of today">
        <p className="text-sm text-zinc-500">
          No transactions yet for any linked investor. Link investors below — once they
          execute BUYs in the portal, the preview will populate.
        </p>
      </Section>
    );
  }
  const partialCount = preview.trailRows.filter((r) => r.partial).length;
  return (
    <Section title={`Calculate as of today — ${preview.asOf.toISOString().slice(0, 10)}`}>
      {/* Totals strip */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Stat label="Total inflow" value={formatBdt(preview.totals.inflow)} muted />
        <Stat
          label="Upfront (per-spec)"
          value={formatBdt(preview.totals.initialUpfront)}
          muted
          hint="initial sourcing only — what the engine writes"
        />
        <Stat
          label="Upfront (every BUY)"
          value={formatBdt(preview.totals.perInflowUpfront)}
          hint="practical: every BUY incl. SIP"
        />
        <Stat label="Trail (quarters to date)" value={formatBdt(preview.totals.trail)} />
        <Stat
          label="Total payable"
          value={formatBdt(preview.totals.totalPayable)}
          emphasis
          hint="per-inflow upfront + trail"
        />
      </div>

      {/* Action buttons */}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <a
          href={`/api/admin/agents/${agentId}/commissions/excel`}
          className="rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-800"
        >
          Download Excel workbook
        </a>
        <form
          action={postAgentCommissions}
          data-confirm={`Post ${countPostable(preview)} commission row(s) to CommissionRun? Idempotent — duplicates are skipped. Partial quarters (cut off at today) are not posted; the cron will pick them up at quarter close.`}
        >
          <input type="hidden" name="agentId" value={agentId} />
          <button
            type="submit"
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
          >
            Post these to CommissionRun
          </button>
        </form>
        {partialCount > 0 && (
          <span className="text-[11px] text-zinc-500">
            {partialCount} partial quarter row(s) shown but not posted yet (cron picks up at
            close).
          </span>
        )}
      </div>

      {/* Per-investor breakdown */}
      <div className="mt-5 overflow-x-auto">
        <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
          <thead className="text-left text-[11px] uppercase tracking-wider text-zinc-500">
            <tr>
              <th className="py-2 pr-3">Investor</th>
              <th className="py-2 pr-3">Name</th>
              <th className="py-2 pr-3">Fund</th>
              <th className="py-2 pr-3">Sourced</th>
              <th className="py-2 pr-3 text-right"># Txns</th>
              <th className="py-2 pr-3 text-right">Inflow</th>
              <th className="py-2 pr-3 text-right">Initial upfront</th>
              <th className="py-2 pr-3 text-right">Per-inflow upfront</th>
              <th className="py-2 pr-3 text-right">Trail</th>
              <th className="py-2 pr-3 text-right">Payable</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {preview.buckets.map((b) => (
              <tr
                key={`${b.investorCode}|${b.fundCode}`}
                className={b.isDirectSubscription ? "text-zinc-400" : ""}
              >
                <td className="py-1.5 pr-3 font-mono text-xs">{b.investorCode}</td>
                <td className="py-1.5 pr-3">
                  {b.name || <span className="italic text-zinc-400">—</span>}
                  {b.isDirectSubscription && (
                    <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[9px] font-medium uppercase text-amber-800 dark:bg-amber-950 dark:text-amber-200">
                      direct
                    </span>
                  )}
                </td>
                <td className="py-1.5 pr-3 text-xs">{b.fundCode}</td>
                <td className="py-1.5 pr-3 text-xs">{b.sourcedOn.toISOString().slice(0, 10)}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{b.txCount}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">
                  {formatBdt(b.inflowTotal)}
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums">
                  {formatBdt(b.initialUpfront)}
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums">
                  {formatBdt(b.perInflowUpfront)}
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums">
                  {formatBdt(b.trailTotal)}
                </td>
                <td className="py-1.5 pr-3 text-right font-semibold tabular-nums">
                  {formatBdt(b.perInflowUpfront + b.trailTotal)}
                </td>
              </tr>
            ))}
            <tr className="border-t-2 border-zinc-300 font-semibold dark:border-zinc-700">
              <td className="py-1.5 pr-3" colSpan={5}>
                TOTAL
              </td>
              <td className="py-1.5 pr-3 text-right tabular-nums">
                {formatBdt(preview.totals.inflow)}
              </td>
              <td className="py-1.5 pr-3 text-right tabular-nums">
                {formatBdt(preview.totals.initialUpfront)}
              </td>
              <td className="py-1.5 pr-3 text-right tabular-nums">
                {formatBdt(preview.totals.perInflowUpfront)}
              </td>
              <td className="py-1.5 pr-3 text-right tabular-nums">
                {formatBdt(preview.totals.trail)}
              </td>
              <td className="py-1.5 pr-3 text-right tabular-nums">
                {formatBdt(preview.totals.totalPayable)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Trail per-quarter detail */}
      {preview.trailRows.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-zinc-500">
            Trail commission — quarter-by-quarter ({preview.trailRows.length} rows)
          </summary>
          <div className="mt-2 overflow-x-auto">
            <table className="min-w-full divide-y divide-zinc-200 text-xs dark:divide-zinc-800">
              <thead className="text-left text-[10px] uppercase tracking-wider text-zinc-500">
                <tr>
                  <th className="py-1.5 pr-3">Investor</th>
                  <th className="py-1.5 pr-3">Fund</th>
                  <th className="py-1.5 pr-3">Quarter</th>
                  <th className="py-1.5 pr-3">Tier</th>
                  <th className="py-1.5 pr-3 text-right">Rate p.a.</th>
                  <th className="py-1.5 pr-3 text-right"># NAV</th>
                  <th className="py-1.5 pr-3 text-right">Avg value</th>
                  <th className="py-1.5 pr-3 text-right">Trail</th>
                  <th className="py-1.5 pr-3">Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {preview.trailRows.map((r, i) => (
                  <tr key={i}>
                    <td className="py-1 pr-3 font-mono">{r.investorCode}</td>
                    <td className="py-1 pr-3">{r.fundCode}</td>
                    <td className="py-1 pr-3 font-mono text-[10px]">
                      {r.quarterStart.toISOString().slice(0, 10)} →{" "}
                      {r.quarterEnd.toISOString().slice(0, 10)}
                    </td>
                    <td className="py-1 pr-3">{r.tier}</td>
                    <td className="py-1 pr-3 text-right tabular-nums">
                      {(r.ratePa * 100).toFixed(4)}%
                    </td>
                    <td className="py-1 pr-3 text-right tabular-nums">{r.navPoints}</td>
                    <td className="py-1 pr-3 text-right tabular-nums">
                      {formatBdt(r.avgValue)}
                    </td>
                    <td className="py-1 pr-3 text-right font-semibold tabular-nums">
                      {formatBdt(r.trail)}
                    </td>
                    <td className="py-1 pr-3 text-[10px] text-amber-700 dark:text-amber-300">
                      {r.partial ? "partial — not posted yet" : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      <p className="mt-3 text-[10px] text-zinc-500">
        Preview is computed live from <code className="font-mono">public.transactions</code> +{" "}
        <code className="font-mono">public.nav_records</code> using the LATEST effective term
        per category. The Excel download contains the same numbers plus a per-transaction
        breakdown. Posting writes rows to{" "}
        <code className="font-mono">xsystem.commission_runs</code> — duplicates are skipped
        via the unique-period index.
      </p>
    </Section>
  );
}

function countPostable(
  preview: Awaited<ReturnType<typeof computeAgentCommissionPreview>>,
): number {
  const upfront = preview.buckets.filter(
    (b) => !b.isDirectSubscription && b.initialUpfront > 0,
  ).length;
  const trail = preview.trailRows.filter((r) => !r.partial).length;
  return upfront + trail;
}

function Stat({
  label,
  value,
  hint,
  emphasis = false,
  muted = false,
}: {
  label: string;
  value: string;
  hint?: string;
  emphasis?: boolean;
  muted?: boolean;
}) {
  return (
    <div
      className={`rounded-md border p-3 ${
        emphasis
          ? "border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950"
          : muted
            ? "border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950"
            : "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"
      }`}
    >
      <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">{label}</p>
      <p
        className={`mt-0.5 font-mono tabular-nums ${
          emphasis ? "text-lg font-bold text-emerald-800 dark:text-emerald-200" : "text-base"
        }`}
      >
        {value}
      </p>
      {hint && <p className="mt-0.5 text-[10px] text-zinc-500">{hint}</p>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-500">{title}</h2>
      <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        {children}
      </div>
    </section>
  );
}
