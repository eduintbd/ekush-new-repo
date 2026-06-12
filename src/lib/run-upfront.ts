// Shared watermark-upfront run, used by /api/cron/monthly-upfront and the
// admin "Post upfront now" action. For each approved agent × fund it
// evaluates the high-water-mark through `throughDate`, and when the agent's
// net invested principal set a new peak it posts ONE agent-level upfront
// CommissionRun on the increment and ratchets the watermark up.
//
// Idempotent: the watermark itself is the guard — re-running a period finds
// peak ≤ stored watermark → increment 0 → no new row.

import { prisma } from "@/lib/prisma";
import { categoryForFund } from "@/lib/ekush-web/types";
import { fetchAgentFundTxns, computeWatermarkUpfront } from "@/lib/upfront-watermark";

export type UpfrontRunResult = {
  created: number;
  evaluated: number;
  agents: number;
  totalUpfront: number;
  period: { start: string; end: string; through: string };
};

type TermLite = {
  fundCategory: "equity" | "fixed_income";
  upfrontPct: number;
  effectiveFrom: Date;
  effectiveTo: Date | null;
};

/** Upfront rate from the term active for this fund's category at `asOf`. */
function upfrontPctFor(terms: TermLite[], fund: string, asOf: Date): number | null {
  const cat = categoryForFund(fund as never);
  const active = terms
    .filter((t) => t.fundCategory === cat && t.effectiveFrom <= asOf && (t.effectiveTo === null || t.effectiveTo > asOf))
    .sort((a, b) => +b.effectiveFrom - +a.effectiveFrom);
  return active[0]?.upfrontPct ?? null;
}

export async function runUpfront(
  periodStart: Date,
  periodEnd: Date,
  throughDate: Date = periodEnd,
  opts: { agentId?: string } = {},
): Promise<UpfrontRunResult> {
  const agents = await prisma.sellingAgent.findMany({
    where: { status: "approved", ...(opts.agentId ? { id: opts.agentId } : {}) },
    include: { terms: true },
  });

  let created = 0;
  let evaluated = 0;
  let totalUpfront = 0;

  for (const agent of agents) {
    const terms: TermLite[] = agent.terms.map((t) => ({
      fundCategory: t.fundCategory,
      upfrontPct: Number(t.upfrontPct),
      effectiveFrom: t.effectiveFrom,
      effectiveTo: t.effectiveTo,
    }));
    const byFund = await fetchAgentFundTxns(prisma, agent.id, throughDate);

    for (const [fundCode, txns] of byFund) {
      const pct = upfrontPctFor(terms, fundCode, periodEnd);
      if (pct === null) continue; // no term for this fund's category

      const wmRow = await prisma.agentUpfrontWatermark.findUnique({
        where: { agentId_fundCode: { agentId: agent.id, fundCode } },
      });
      const stored = wmRow ? Number(wmRow.watermark) : 0;
      const res = computeWatermarkUpfront(txns, stored, pct);
      evaluated++;

      await prisma.$transaction(async (tx) => {
        if (res.increment > 0) {
          await tx.commissionRun.create({
            data: {
              agentId: agent.id,
              agentInvestorId: null,
              fundCode,
              type: "upfront",
              periodStart,
              periodEnd,
              baseAmount: res.increment,
              rateApplied: pct,
              amount: res.upfront,
              notes: `Watermark upfront ${fundCode}: net principal peaked ${res.peak.toFixed(2)} (prev ${stored.toFixed(2)}); incremental ${res.increment.toFixed(2)} × ${(pct * 100).toFixed(4)}%`,
            },
          });
          created++;
          totalUpfront += res.upfront;
        }
        await tx.agentUpfrontWatermark.upsert({
          where: { agentId_fundCode: { agentId: agent.id, fundCode } },
          create: { agentId: agent.id, fundCode, watermark: res.newWatermark, throughDate: periodEnd },
          update: { watermark: res.newWatermark, throughDate: periodEnd },
        });
      });
    }
  }

  return {
    created,
    evaluated,
    agents: agents.length,
    totalUpfront: Math.round(totalUpfront * 100) / 100,
    period: {
      start: periodStart.toISOString().slice(0, 10),
      end: periodEnd.toISOString().slice(0, 10),
      through: throughDate.toISOString().slice(0, 10),
    },
  };
}
