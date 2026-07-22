// Shared watermark-upfront run, used by /api/cron/monthly-upfront and the
// admin "Post upfront now" action. For each approved agent × INVESTOR it
// evaluates the combined-fund high-water-mark through `throughDate`, and when
// that investor's net invested principal set a new peak it posts upfront on
// the increment and ratchets the watermark up.
//
// Combined across funds (2026-07): an investor redeeming from one fund and
// subscribing to another produces no new money, so a switch pays nothing. See
// src/lib/upfront-watermark.ts for why this needs no switch detection.
//
// Idempotent twice over: the watermark itself (re-running a period finds
// peak ≤ watermark → increment 0), and — now that upfront rows carry
// agentInvestorId — the (agent_investor_id, type, period_start, period_end)
// unique index, which was dormant while those rows passed null.

import { prisma, withActor } from "@/lib/prisma";
import { categoryForFund, type FundCode } from "@/lib/ekush-web/types";
import {
  fetchAgentInvestorTxns,
  computeCombinedWatermarkUpfront,
  isUpfrontEntitled,
  type RateResolver,
  type FetchWarning,
} from "@/lib/upfront-watermark";

export type UpfrontBlocked = {
  agentCode: string;
  investorCode: string;
  reason: string;
};

export type UpfrontRunResult = {
  dryRun: boolean;
  created: number;
  evaluated: number;
  agents: number;
  /** Agents skipped because upfront was suspended for the period. */
  suspended: number;
  /** Investors deliberately not posted — missing term, or a data warning. */
  blocked: number;
  blockedDetail: UpfrontBlocked[];
  warnings: FetchWarning[];
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
function makeRateResolver(terms: TermLite[], asOf: Date): RateResolver {
  return (fundCode: string) => {
    const category = categoryForFund(fundCode as FundCode);
    const active = terms
      .filter(
        (t) =>
          t.fundCategory === category &&
          t.effectiveFrom <= asOf &&
          (t.effectiveTo === null || t.effectiveTo > asOf),
      )
      .sort((a, b) => +b.effectiveFrom - +a.effectiveFrom);
    const t = active[0];
    return t ? { rate: t.upfrontPct, category } : null;
  };
}

export async function runUpfront(
  periodStart: Date,
  periodEnd: Date,
  throughDate: Date = periodEnd,
  opts: { agentId?: string; dryRun?: boolean } = {},
): Promise<UpfrontRunResult> {
  const dryRun = opts.dryRun === true;
  const agents = await prisma.sellingAgent.findMany({
    where: { status: "approved", ...(opts.agentId ? { id: opts.agentId } : {}) },
    include: { terms: true, upfrontSuspensions: true, investors: true },
  });

  let created = 0;
  let evaluated = 0;
  let suspended = 0;
  let blocked = 0;
  let totalUpfront = 0;
  const blockedDetail: UpfrontBlocked[] = [];
  const allWarnings: FetchWarning[] = [];

  for (const agent of agents) {
    // Accountant-controlled entitlement: while suspended the agent earns no
    // upfront — and the watermark is left untouched (forfeit, no catch-up; the
    // accountant sets it manually at re-instatement).
    if (!isUpfrontEntitled(agent.upfrontSuspensions, periodEnd)) {
      suspended++;
      continue;
    }

    const terms: TermLite[] = agent.terms.map((t) => ({
      fundCategory: t.fundCategory,
      upfrontPct: Number(t.upfrontPct),
      effectiveFrom: t.effectiveFrom,
      effectiveTo: t.effectiveTo,
    }));
    const rateFor = makeRateResolver(terms, periodEnd);

    const { byInvestor, warnings } = await fetchAgentInvestorTxns(prisma, agent.id, throughDate);
    allWarnings.push(...warnings);

    // Investors carrying a data warning that could distort the replay are not
    // posted at all. `direct_mixed` and `same_day_buy_sell` are advisory — they
    // need a human eye but do not corrupt the arithmetic — so they don't block.
    const blocking = new Set(
      warnings
        .filter((w) => w.kind === "unknown_direction" || w.kind === "cip_no_candidate_buy")
        .map((w) => w.investorCode),
    );

    // (investorCode, fundCode) → AgentInvestor link id, earliest sourcedOn.
    const linkByPair = new Map<string, { id: string; sourcedOn: Date }>();
    for (const l of agent.investors) {
      const key = `${l.investorCode}|${l.fundCode}`;
      const cur = linkByPair.get(key);
      if (!cur || l.sourcedOn < cur.sourcedOn) {
        linkByPair.set(key, { id: l.id, sourcedOn: l.sourcedOn });
      }
    }

    for (const [investorCode, txns] of byInvestor) {
      evaluated++;

      if (blocking.has(investorCode)) {
        blocked++;
        blockedDetail.push({
          agentCode: agent.code,
          investorCode,
          reason: "data warning on this investor's transactions — see warnings",
        });
        continue;
      }

      const wmRow = await prisma.agentInvestorWatermark.findUnique({
        where: { agentId_investorCode: { agentId: agent.id, investorCode } },
      });
      const stored = wmRow ? Number(wmRow.watermark) : 0;

      let res;
      try {
        res = computeCombinedWatermarkUpfront(txns, stored, rateFor);
      } catch (err) {
        blocked++;
        blockedDetail.push({
          agentCode: agent.code,
          investorCode,
          reason: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      // A fund with no active term used to be skipped, which silently dropped
      // its whole transaction series. Under the combined model that CORRUPTS
      // the series — the dropped SELLs stop cancelling — so refuse to post and
      // leave the watermark where it is. The accountant adds the term and
      // re-runs; nothing was lost.
      if (res.unratedFunds.length > 0) {
        blocked++;
        blockedDetail.push({
          agentCode: agent.code,
          investorCode,
          reason: `no active term for ${res.unratedFunds.join(", ")} — nothing posted, watermark unchanged`,
        });
        continue;
      }

      // Dry run: count what WOULD post, write nothing (no CommissionRun, no
      // watermark advance). This is what makes `?dryRun=1` on the cron route a
      // genuine preview rather than a live run.
      if (dryRun) {
        for (const slice of res.slices) {
          if (slice.upfront <= 0) continue;
          created++;
          totalUpfront += slice.upfront;
        }
        continue;
      }

      await withActor(null, async (tx) => {
        for (const slice of res.slices) {
          if (slice.upfront <= 0) continue;
          const link = linkByPair.get(`${investorCode}|${slice.fundCode}`);
          await tx.commissionRun.create({
            data: {
              agentId: agent.id,
              // Populating this activates the dormant unique index, giving
              // upfront real DB-level idempotency for the first time.
              agentInvestorId: link?.id ?? null,
              fundCode: slice.fundCode,
              type: "upfront",
              periodStart,
              periodEnd,
              baseAmount: slice.base,
              rateApplied: slice.rate,
              amount: slice.upfront,
              notes:
                `Combined watermark upfront · investor ${investorCode} · driver ${slice.fundCode} (${slice.category}) · ` +
                `net principal peaked ${res.peak.toFixed(2)} (prev watermark ${stored.toFixed(2)}) · ` +
                `slice base ${slice.base.toFixed(2)} × ${(slice.rate * 100).toFixed(4)}% · ` +
                `total increment ${res.increment.toFixed(2)} across ${res.slices.length} fund(s) · ` +
                `CIP excluded ${res.cipOffset.toFixed(2)} · ${res.txCount} movements`,
            },
          });
          created++;
          totalUpfront += slice.upfront;
        }

        await tx.agentInvestorWatermark.upsert({
          where: { agentId_investorCode: { agentId: agent.id, investorCode } },
          create: {
            agentId: agent.id,
            investorCode,
            watermark: res.newWatermark,
            netPrincipal: res.netPrincipal,
            cipOffset: res.cipOffset,
            throughDate: periodEnd,
          },
          update: {
            watermark: res.newWatermark,
            netPrincipal: res.netPrincipal,
            cipOffset: res.cipOffset,
            throughDate: periodEnd,
          },
        });
      });
    }
  }

  return {
    dryRun,
    created,
    evaluated,
    agents: agents.length,
    suspended,
    blocked,
    blockedDetail,
    warnings: allWarnings,
    totalUpfront: Math.round(totalUpfront * 100) / 100,
    period: {
      start: periodStart.toISOString().slice(0, 10),
      end: periodEnd.toISOString().slice(0, 10),
      through: throughDate.toISOString().slice(0, 10),
    },
  };
}
