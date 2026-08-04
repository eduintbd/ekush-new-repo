// Shared watermark-upfront run, used by /api/cron/monthly-upfront and the
// admin "Post upfront now" action. For each approved AGENT it evaluates the
// book-level high-water-mark through `throughDate` — every investor they
// sourced, all funds, as one net-principal series — and when that book sets a
// new peak it posts upfront on the increment and ratchets the watermark up.
//
// Combined across funds (2026-07): an investor redeeming from one fund and
// subscribing to another produces no new money, so a switch pays nothing.
//
// Book-level (2026-08): money moved between two of the agent's OWN CLIENTS is
// likewise not new money. See src/lib/upfront-watermark.ts for why neither
// needs detection — both fall out of the arithmetic.
//
// Idempotent twice over: the watermark itself (re-running a period finds
// peak ≤ watermark → increment 0), and the
// (agent_investor_id, type, period_start, period_end) unique index. The second
// one only works because slices still carry an investorCode, so every posted
// row resolves a real AgentInvestor link — a null there would collide with
// nothing and the index would go dormant again.

import { prisma, withActor } from "@/lib/prisma";
import {
  fetchAgentInvestorTxns,
  flattenToAgentSeries,
  computeCombinedWatermarkUpfront,
  isUpfrontEntitled,
  makeRateResolver,
  type FetchWarning,
  type TermLite,
} from "@/lib/upfront-watermark";

export type UpfrontBlocked = {
  agentCode: string;
  /** Null when the whole agent was blocked rather than one investor. */
  investorCode: string | null;
  reason: string;
};

export type UpfrontRunResult = {
  dryRun: boolean;
  created: number;
  evaluated: number;
  agents: number;
  /** Agents skipped because upfront was suspended for the period. */
  suspended: number;
  /** Agents deliberately not posted — missing term, or a data warning. */
  blocked: number;
  blockedDetail: UpfrontBlocked[];
  warnings: FetchWarning[];
  totalUpfront: number;
  period: { start: string; end: string; through: string };
  /** Agent ids that matched `opts.agentId` but were not approved. Lets the
   *  admin action say so instead of reporting "nothing to post". */
  notApproved: string[];
};

// `makeRateResolver` lives in upfront-watermark.ts so the preview and the agent
// calculator resolve the rate exactly the way this runner does. It used to be
// private here, and the preview had its own "latest term, applied
// retroactively" copy — a divergence waiting for the first term with a future
// start date.

export async function runUpfront(
  periodStart: Date,
  periodEnd: Date,
  throughDate: Date = periodEnd,
  opts: {
    agentId?: string;
    dryRun?: boolean;
    /**
     * Who is posting, recorded on every audit_log row this run writes. The
     * accountant's id when posted from the agent page; null only for an
     * unattended run. This used to be hardcoded null, so every upfront row
     * ever written was unattributable — 299 of them.
     */
    actorId?: string | null;
  } = {},
): Promise<UpfrontRunResult> {
  const dryRun = opts.dryRun === true;
  const agents = await prisma.sellingAgent.findMany({
    where: { status: "approved", ...(opts.agentId ? { id: opts.agentId } : {}) },
    include: { terms: true, upfrontSuspensions: true, investors: true },
  });

  // A named agent that matched nothing is almost always an unapproved one. The
  // caller could not tell that apart from "nothing to pay" — the admin button
  // reported "no new money above the watermark" for an agent sitting on a real
  // pending increment, purely because its status was `pending`.
  const notApproved: string[] = [];
  if (opts.agentId && agents.length === 0) {
    const named = await prisma.sellingAgent.findUnique({
      where: { id: opts.agentId },
      select: { code: true, status: true },
    });
    if (named) notApproved.push(`${named.code} is ${named.status}, not approved`);
  }

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

    // A data warning that could distort the replay now blocks the WHOLE AGENT,
    // not just the investor carrying it. Under the book model every investor
    // shares one series, so dropping one investor's rows corrupts it — their
    // SELLs stop cancelling and the remaining subscriptions read as new money.
    // Same reasoning as the unrated-fund block below. `direct_mixed` and
    // `same_day_buy_sell` stay advisory: they need a human eye but do not
    // corrupt the arithmetic.
    const blockingWarnings = warnings.filter(
      (w) => w.kind === "unknown_direction" || w.kind === "cip_no_candidate_buy",
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

    evaluated++;

    if (blockingWarnings.length > 0) {
      blocked++;
      blockedDetail.push({
        agentCode: agent.code,
        investorCode: null,
        reason:
          `data warning on ${[...new Set(blockingWarnings.map((w) => w.investorCode))].join(", ")} — ` +
          `the whole book shares one series, so nothing posts for this agent until it is resolved`,
      });
      continue;
    }

    const wmRow = await prisma.agentBookWatermark.findUnique({
      where: { agentId: agent.id },
    });
    const stored = wmRow ? Number(wmRow.watermark) : 0;

    let res;
    try {
      res = computeCombinedWatermarkUpfront(flattenToAgentSeries(byInvestor), stored, rateFor);
    } catch (err) {
      blocked++;
      blockedDetail.push({
        agentCode: agent.code,
        investorCode: null,
        reason: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    // A fund with no active term used to be skipped, which silently dropped its
    // whole transaction series. That CORRUPTS the book series — the dropped
    // SELLs stop cancelling — so refuse to post and leave the watermark where
    // it is. The accountant adds the term and re-runs; nothing was lost.
    if (res.unratedFunds.length > 0) {
      blocked++;
      blockedDetail.push({
        agentCode: agent.code,
        investorCode: null,
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

    await withActor(opts.actorId ?? null, async (tx) => {
      for (const slice of res.slices) {
        if (slice.upfront <= 0) continue;
        // The slice carries its own investor, so the link still resolves even
        // though the replay was book-wide. That keeps agentInvestorId non-null
        // and the (agent_investor_id, type, period_start, period_end) unique
        // index doing its job.
        const link = linkByPair.get(`${slice.investorCode}|${slice.fundCode}`);
        await tx.commissionRun.create({
          data: {
            agentId: agent.id,
            agentInvestorId: link?.id ?? null,
            fundCode: slice.fundCode,
            type: "upfront",
            periodStart,
            periodEnd,
            baseAmount: slice.base,
            rateApplied: slice.rate,
            amount: slice.upfront,
            // `investor {code} ` is parsed back out by the restatement
            // scripts — keep the token if this string is ever reworded.
            notes:
              `Book watermark upfront · investor ${slice.investorCode} · driver ${slice.fundCode} (${slice.category}) · ` +
              `book net principal peaked ${res.peak.toFixed(2)} (prev watermark ${stored.toFixed(2)}) · ` +
              `slice base ${slice.base.toFixed(2)} × ${(slice.rate * 100).toFixed(4)}% · ` +
              `total increment ${res.increment.toFixed(2)} across ${res.slices.length} slice(s) · ` +
              `CIP excluded ${res.cipOffset.toFixed(2)} · ${res.txCount} movements`,
          },
        });
        created++;
        totalUpfront += slice.upfront;
      }

      await tx.agentBookWatermark.upsert({
        where: { agentId: agent.id },
        create: {
          agentId: agent.id,
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

  return {
    dryRun,
    created,
    evaluated,
    agents: agents.length,
    suspended,
    blocked,
    blockedDetail,
    warnings: allWarnings,
    notApproved,
    totalUpfront: Math.round(totalUpfront * 100) / 100,
    period: {
      start: periodStart.toISOString().slice(0, 10),
      end: periodEnd.toISOString().slice(0, 10),
      through: throughDate.toISOString().slice(0, 10),
    },
  };
}
