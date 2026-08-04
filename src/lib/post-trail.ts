// Shared trail posting, used by /api/cron/monthly-trail and the admin
// "Post trail to CommissionRun" action. Mirrors run-upfront.ts: ONE function,
// both callers, so what the cron writes is what a human saw on screen.
//
// The numbers come from `computeAgentCommissionPreview` — the same engine
// behind /agent/earnings, /admin/agents/[id] and the Excel workbook. It
// replaces the old run-trail.ts, which read `xsystem.nav_snapshots` (a table
// with no writer anywhere in the repo) and therefore posted nothing, ever.
//
// The cron never passes `asOf`, so it lets the preview default to now. That is
// what makes cron output identical to the admin button by construction —
// unless the admin has explicitly set a billing cut-off on the page, in which
// case the button passes that date through and posts exactly what was shown.
// `periodsFor` caps the final period at asOf and flags it `partial`, so a
// single monthly cron correctly serves both monthly and quarterly cadences —
// a quarterly bucket simply stays partial until its quarter closes.
//
// Idempotent: posting ALL completed periods every run, with the
// (agent_investor_id, type, period_start, period_end) unique index absorbing
// what already exists. That also means a missed or failed run self-heals on
// the next one, which the old one-period-per-invocation design could not do.

import { prisma, withActor } from "@/lib/prisma";
import { computeAgentCommissionPreview } from "@/lib/agent-commission-preview";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export type TrailOverlap = {
  agentInvestorId: string;
  /** The period we refused to post. */
  candidate: string;
  /** The already-posted period it overlaps. */
  existing: string;
};

export type AgentTrailPostResult = {
  agentId: string;
  agentCode: string;
  /** preview.totals.trail — what the agent sees on screen. */
  previewTrailTotal: number;
  /** Non-partial rows eligible to post. */
  eligibleRows: number;
  created: number;
  duplicates: number;
  partialSkipped: number;
  overlaps: TrailOverlap[];
  /** Money actually written by this run (or that a dry run would write). */
  createdAmount: number;
  /** Σ posted trail in commission_runs after this run. */
  postedTrailTotal: number;
  /** previewTrailTotal − postedTrailTotal. Non-zero = screen and ledger disagree. */
  drift: number;
  error: string | null;
};

export type TrailPostResult = {
  asOf: string;
  dryRun: boolean;
  agents: number;
  agentsFailed: number;
  created: number;
  duplicates: number;
  partialSkipped: number;
  overlapConflicts: number;
  createdAmount: number;
  perAgent: AgentTrailPostResult[];
};

/** Inclusive-bounds overlap test. */
function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

function samePeriod(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return +aStart === +bStart && +aEnd === +bEnd;
}

async function sumPostedTrail(agentId: string): Promise<number> {
  const agg = await prisma.commissionRun.aggregate({
    where: { agentId, type: "trail" },
    _sum: { amount: true },
  });
  return round2(Number(agg._sum.amount ?? 0));
}

export async function postTrailFromPreview(
  opts: {
    /** Single agent (admin button). Omit to run every approved agent (cron). */
    agentId?: string;
    /** Optional floor on periodStart — skips anything starting before this. */
    since?: Date;
    /** Compute and report everything, write nothing. */
    dryRun?: boolean;
    /** Attributed in the audit trail. null for cron. */
    actorId?: string | null;
    /** Billing cut-off. Omit (cron) to compute at now. */
    asOf?: Date;
  } = {},
): Promise<TrailPostResult> {
  const dryRun = opts.dryRun === true;

  // An explicit agentId is a deliberate admin act, so it is not filtered on
  // status; the unattended cron only ever touches approved agents.
  const agents = await prisma.sellingAgent.findMany({
    where: opts.agentId ? { id: opts.agentId } : { status: "approved" },
    select: { id: true, code: true },
    orderBy: { code: "asc" },
  });

  const perAgent: AgentTrailPostResult[] = [];

  for (const agent of agents) {
    // Per-agent isolation: one agent's bad data must not abort the rest of
    // the run (the engine this replaces had no such isolation).
    try {
      perAgent.push(await postForAgent(agent.id, agent.code, dryRun, opts));
    } catch (err) {
      perAgent.push({
        agentId: agent.id,
        agentCode: agent.code,
        previewTrailTotal: 0,
        eligibleRows: 0,
        created: 0,
        duplicates: 0,
        partialSkipped: 0,
        overlaps: [],
        createdAmount: 0,
        postedTrailTotal: 0,
        drift: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const sum = (pick: (r: AgentTrailPostResult) => number): number =>
    perAgent.reduce((s, r) => s + pick(r), 0);

  return {
    asOf: (opts.asOf ?? new Date()).toISOString(),
    dryRun,
    agents: agents.length,
    agentsFailed: perAgent.filter((r) => r.error !== null).length,
    created: sum((r) => r.created),
    duplicates: sum((r) => r.duplicates),
    partialSkipped: sum((r) => r.partialSkipped),
    overlapConflicts: sum((r) => r.overlaps.length),
    createdAmount: round2(sum((r) => r.createdAmount)),
    perAgent,
  };
}

async function postForAgent(
  agentId: string,
  agentCode: string,
  dryRun: boolean,
  opts: { since?: Date; actorId?: string | null; asOf?: Date },
): Promise<AgentTrailPostResult> {
  const preview = await computeAgentCommissionPreview(prisma, agentId, opts.asOf);

  const completed = preview.trailRows.filter((r) => !r.partial);
  const partialSkipped = preview.trailRows.length - completed.length;
  const eligible = opts.since
    ? completed.filter((r) => r.quarterStart >= opts.since!)
    : completed;

  // Already-posted trail periods for these links.
  const linkIds = Array.from(new Set(eligible.map((r) => r.agentInvestorId)));
  const existing = linkIds.length
    ? await prisma.commissionRun.findMany({
        where: { agentId, type: "trail", agentInvestorId: { in: linkIds } },
        select: { agentInvestorId: true, periodStart: true, periodEnd: true },
      })
    : [];

  const existingByLink = new Map<string, Array<{ start: Date; end: Date }>>();
  for (const e of existing) {
    if (!e.agentInvestorId || !e.periodStart || !e.periodEnd) continue;
    const arr = existingByLink.get(e.agentInvestorId) ?? [];
    arr.push({ start: e.periodStart, end: e.periodEnd });
    existingByLink.set(e.agentInvestorId, arr);
  }

  // The unique index only catches EXACT period matches. If a term's cadence is
  // flipped (monthly → quarterly) after rows are posted, the preview
  // regenerates the same calendar time under different bounds — those do NOT
  // collide, and the agent would be paid twice for the same months. Refuse and
  // report instead; a correction must be a deliberate adjustment, never a
  // silent second insert.
  const conflicts: TrailOverlap[] = [];
  const safe = eligible.filter((r) => {
    const prior = existingByLink.get(r.agentInvestorId) ?? [];
    const clash = prior.find(
      (p) =>
        overlaps(r.quarterStart, r.quarterEnd, p.start, p.end) &&
        !samePeriod(r.quarterStart, r.quarterEnd, p.start, p.end),
    );
    if (clash) {
      conflicts.push({
        agentInvestorId: r.agentInvestorId,
        candidate: `${ymd(r.quarterStart)}..${ymd(r.quarterEnd)}`,
        existing: `${ymd(clash.start)}..${ymd(clash.end)}`,
      });
      return false;
    }
    return true;
  });

  // Two distinct dates, and the notes carry both: `postedOn` is when the row
  // was written, `cutOff` is the billing date it was computed at. They differ
  // whenever an accountant bills a closed period after the fact, and only the
  // latter explains the amount.
  const postedOn = ymd(new Date());
  const cutOff = ymd(preview.asOf);
  const data = safe.map((r) => ({
    agentId,
    agentInvestorId: r.agentInvestorId,
    type: "trail" as const,
    periodStart: r.quarterStart,
    periodEnd: r.quarterEnd,
    baseAmount: round2(r.avgValue),
    rateApplied: r.rateQuarter,
    amount: r.trail,
    notes: `${r.navPoints} NAV pts · ${r.tier} tier · posted ${postedOn} from preview as of ${cutOff}`,
  }));

  // Rows that do not already exist verbatim. Computing this explicitly (rather
  // than inferring it from the insert count) lets a dry run report exactly what
  // a live run would write.
  const exactKeys = new Set(
    existing
      .filter((e) => e.agentInvestorId && e.periodStart && e.periodEnd)
      .map((e) => `${e.agentInvestorId}|${+e.periodStart!}|${+e.periodEnd!}`),
  );
  const toCreate = data.filter(
    (d) => !exactKeys.has(`${d.agentInvestorId}|${+d.periodStart}|${+d.periodEnd}`),
  );

  const postedBefore = await sumPostedTrail(agentId);

  let created = toCreate.length;
  if (!dryRun && toCreate.length > 0) {
    // One ON CONFLICT DO NOTHING statement rather than N try/catch round-trips:
    // exact insert count, a millisecond-long transaction instead of a
    // second-long one, and — critically — real errors surface instead of being
    // swallowed as "skipped" the way the old bare catch did. skipDuplicates
    // still guards the race against a concurrent admin click.
    const res = await withActor(opts.actorId ?? null, (tx) =>
      tx.commissionRun.createMany({ data: toCreate, skipDuplicates: true }),
    );
    created = res.count;
  }

  const postedTrailTotal = dryRun ? postedBefore : await sumPostedTrail(agentId);
  const previewTrailTotal = round2(preview.totals.trail);
  const createdAmount = dryRun
    ? round2(toCreate.reduce((s, d) => s + d.amount, 0))
    : round2(postedTrailTotal - postedBefore);

  return {
    agentId,
    agentCode,
    previewTrailTotal,
    eligibleRows: eligible.length,
    created,
    duplicates: data.length - toCreate.length,
    partialSkipped,
    overlaps: conflicts,
    createdAmount,
    postedTrailTotal,
    // On a dry run nothing was written, so drift is the gap this run WOULD
    // close. After a live run it should be ~0; anything else means the screen
    // and the ledger disagree.
    drift: round2(previewTrailTotal - postedTrailTotal),
    error: null,
  };
}
