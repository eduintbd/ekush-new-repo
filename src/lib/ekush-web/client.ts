// Ekush-web investor lookup. Returns the EkushWebInvestor[] shape used by
// the commission engine + agent portal.
//
// Today (Phase 1): reads xsystem.agent_investors (X-System-owned links
// admin manually creates per agent) and enriches each row with real data
// from public.investors + public.fund_holdings on the shared Supabase.
// No HTTP call. No mock fallback once an agent has at least one link.
//
// When the agent has zero xsystem.agent_investors rows, we keep the
// deterministic mock as a fallback so dev / demo continues to work.

import type { EkushWebInvestor, FundCode } from "./types";
import { mockInvestorsForAgent } from "./mock";
import { prisma } from "@/lib/prisma";
import {
  getAllFunds,
  getHoldings,
  getInvestorsByCode,
  getRedemptions,
} from "@/lib/portal-data";

export type FetchOptions = { bypassCache?: boolean };

/**
 * Returns the investor cohort sourced by the agent with the given code.
 *
 * Resolution order:
 *   1. Look up the agent in xsystem.selling_agents by code → get agent.id.
 *   2. Look up xsystem.agent_investors WHERE agent_id = agent.id.
 *   3. If any link rows exist, enrich with real public.investors + public.fund_holdings data.
 *   4. If no link rows exist, fall back to the deterministic mock cohort.
 */
export async function fetchInvestorsForAgent(
  agentCode: string,
  _opts: FetchOptions = {},
): Promise<EkushWebInvestor[]> {
  // 1. Resolve agent
  const agent = await prisma.sellingAgent.findUnique({
    where: { code: agentCode },
    select: { id: true },
  });
  if (!agent) {
    // Agent doesn't exist in xsystem at all — fall back to mock (demo / placeholder).
    return mockInvestorsForAgent(agentCode);
  }

  // 2. Pull the explicit links admin has created in xsystem.agent_investors
  const links = await prisma.agentInvestor.findMany({
    where: { agentId: agent.id },
    orderBy: { sourcedOn: "desc" },
  });
  if (links.length === 0) {
    // Admin hasn't linked any investors to this agent yet — keep the mock
    // showing so the agent portal isn't a wall of "no data".
    return mockInvestorsForAgent(agentCode);
  }

  // 3. Enrich with portal-owned investor + holding data
  const codes = Array.from(new Set(links.map((l) => l.investorCode)));
  const investorMap = await getInvestorsByCode(codes);
  const fundMap = await getAllFunds();

  // Build holding-lookup pairs (investorId, fundId) from the link rows
  const pairs: Array<{ investorId: string; fundId: string }> = [];
  for (const link of links) {
    const inv = investorMap.get(link.investorCode);
    const fund = fundMap.get(link.fundCode);
    if (inv && fund) pairs.push({ investorId: inv.id, fundId: fund.id });
  }
  // Pull holdings + redemptions in parallel. Redemptions are pulled from
  // public.transactions WHERE direction = 'SELL' AND status = 'EXECUTED',
  // filtered to redemptions at-or-after the earliest sourced_on across
  // the agent's links (anything earlier is irrelevant to clawback /
  // trail computation for THIS agent's investors).
  const earliestSourced = links.reduce<Date | null>(
    (acc, l) => (acc === null || l.sourcedOn < acc ? l.sourcedOn : acc),
    null,
  );
  const [holdingMap, redemptionMap] = await Promise.all([
    getHoldings(pairs),
    getRedemptions(pairs, earliestSourced ?? undefined),
  ]);

  // 4. Project into EkushWebInvestor shape
  const out: EkushWebInvestor[] = [];
  for (const link of links) {
    const inv = investorMap.get(link.investorCode);
    const fund = fundMap.get(link.fundCode);
    const key = inv && fund ? `${inv.id}|${fund.id}` : "";
    const holding = key ? holdingMap.get(key) : null;
    const reds = key ? redemptionMap.get(key) ?? [] : [];
    out.push({
      investor_code: link.investorCode,
      full_name: inv?.name ?? "(investor not found in portal)",
      fund_code: link.fundCode as FundCode,
      sourced_on: link.sourcedOn.toISOString().slice(0, 10),
      initial_units: Number(link.initialUnits),
      unit_price_at_sourcing: Number(link.unitPriceAtSourcing),
      // Use live holding if available; otherwise fall back to xsystem link value
      units_outstanding: holding ? holding.totalCurrentUnits : Number(link.initialUnits),
      // Real redemptions sourced from public.transactions (SELL / EXECUTED)
      // and filtered to those at-or-after the link's sourced_on date.
      redemptions: reds
        .filter((r) => r.date >= link.sourcedOn)
        .map((r) => ({
          date: r.date.toISOString().slice(0, 10),
          units: r.units,
          gross: r.gross,
        })),
      is_direct_subscription: link.isDirectSubscription,
      management_fee_charged_ytd: 0, // requires portal-side accounting; defer.
    });
  }
  return out;
}
