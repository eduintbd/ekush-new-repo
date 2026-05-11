// POST /api/cron/quarterly-trail
// Computes a CommissionRun row for every (agent, agent_investor) combo
// for the supplied quarter. Idempotent: the (agent_investor_id, type,
// period_start, period_end) unique constraint blocks duplicates.
//
// Auth: simple shared-secret header X-Cron-Secret. Add CRON_SECRET to env.

import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  computeQuarterlyTrail,
  type AgentTermSnapshot,
  type WeeklyNav,
} from "@/lib/commission-engine";
import { fetchInvestorsForAgent } from "@/lib/ekush-web/client";
import type { FundCode } from "@/lib/ekush-web/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (req.headers.get("x-cron-secret") !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    quarterStart?: string;
    quarterEnd?: string;
  };
  if (!body.quarterStart || !body.quarterEnd) {
    return NextResponse.json(
      { error: "quarterStart and quarterEnd (YYYY-MM-DD) required" },
      { status: 400 },
    );
  }
  const qStart = new Date(`${body.quarterStart}T00:00:00Z`);
  const qEnd = new Date(`${body.quarterEnd}T00:00:00Z`);

  const agents = await prisma.sellingAgent.findMany({
    where: { status: "approved" },
    include: { terms: true, investors: true },
  });

  const navSnaps = await prisma.navSnapshot.findMany({
    where: { snapshotDate: { gte: qStart, lte: qEnd } },
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
      const result = computeQuarterlyTrail(inv, termSnaps, navByFund, qStart, qEnd);
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

  console.log(
    JSON.stringify({
      event: "commission.run",
      type: "quarterly-trail",
      quarterStart: body.quarterStart,
      quarterEnd: body.quarterEnd,
      created,
      skipped,
      agents: agents.length,
      at: new Date().toISOString(),
    }),
  );

  return NextResponse.json({ created, skipped, quarter: body });
}
