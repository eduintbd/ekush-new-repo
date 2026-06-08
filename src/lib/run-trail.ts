// Shared trail-commission run, used by both /api/cron/monthly-trail and
// /api/cron/quarterly-trail. Computes a `trail` CommissionRun row for every
// (agent, agent_investor) whose term is set to the requested cadence, over
// the given [periodStart, periodEnd] window. Idempotent: the
// (agent_investor_id, type, period_start, period_end) unique constraint
// blocks duplicates, so re-running a period is safe.

import { prisma } from "@/lib/prisma";
import {
  computeTrail,
  periodsPerYear,
  type AgentTermSnapshot,
  type TrailFrequency,
  type WeeklyNav,
} from "@/lib/commission-engine";
import { fetchInvestorsForAgent } from "@/lib/ekush-web/client";
import type { FundCode } from "@/lib/ekush-web/types";

function normalizeFrequency(raw: string): TrailFrequency {
  return raw === "monthly" ? "monthly" : "quarterly";
}

export type TrailRunResult = {
  created: number;
  skipped: number;
  agents: number;
  frequency: TrailFrequency;
  period: { start: string; end: string };
};

export async function runTrail(
  periodStart: Date,
  periodEnd: Date,
  frequency: TrailFrequency,
): Promise<TrailRunResult> {
  const agents = await prisma.sellingAgent.findMany({
    where: { status: "approved" },
    include: { terms: true, investors: true },
  });

  const navSnaps = await prisma.navSnapshot.findMany({
    where: { snapshotDate: { gte: periodStart, lte: periodEnd } },
  });
  const navByFund = new Map<FundCode, WeeklyNav[]>();
  for (const n of navSnaps) {
    const fc = n.fundCode as FundCode;
    if (!navByFund.has(fc)) navByFund.set(fc, []);
    navByFund.get(fc)!.push({ date: n.snapshotDate, unitNav: Number(n.unitNav) });
  }

  let created = 0;
  let skipped = 0;
  for (const agent of agents) {
    const termSnaps: AgentTermSnapshot[] = agent.terms.map((t) => ({
      fundCategory: t.fundCategory,
      upfrontPct: Number(t.upfrontPct),
      trailY1PctPa: Number(t.trailY1PctPa),
      trailY2PlusPctPa: Number(t.trailY2PlusPctPa),
      trailFrequency: normalizeFrequency(t.trailFrequency),
      clawbackMonths: t.clawbackMonths,
      clawbackPct: Number(t.clawbackPct),
      effectiveFrom: t.effectiveFrom,
      effectiveTo: t.effectiveTo,
    }));

    const investors = await fetchInvestorsForAgent(agent.code);
    for (const inv of investors) {
      const ai = agent.investors.find(
        (x) =>
          x.investorCode === inv.investor_code &&
          x.fundCode === inv.fund_code &&
          x.sourcedOn.toISOString().slice(0, 10) === inv.sourced_on,
      );
      if (!ai) {
        skipped++;
        continue;
      }
      const result = computeTrail(inv, termSnaps, navByFund, periodStart, periodEnd, frequency);
      if (!result) {
        skipped++;
        continue;
      }
      try {
        await prisma.commissionRun.create({
          data: {
            agentId: agent.id,
            agentInvestorId: ai.id,
            type: "trail",
            periodStart: result.periodStart,
            periodEnd: result.periodEnd,
            baseAmount: result.baseAmount,
            rateApplied: result.rateApplied,
            amount: result.amount,
            notes: result.notes,
          },
        });
        created++;
      } catch {
        // unique constraint hit — already ran for this period
        skipped++;
      }
    }
  }

  return {
    created,
    skipped,
    agents: agents.length,
    frequency,
    period: {
      start: periodStart.toISOString().slice(0, 10),
      end: periodEnd.toISOString().slice(0, 10),
    },
  };
}

/** Exposed for callers that want to annotate logs with the divisor used. */
export { periodsPerYear };
