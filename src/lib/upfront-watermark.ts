// Agent-level high-water-mark (HWM) upfront commission engine.
//
// Upfront is paid only on the increment of an agent's NET INVESTED
// PRINCIPAL (Σ BUY−SELL cash, per fund) above its prior peak. The peak
// (watermark) ratchets up and never falls when clients redeem — money that
// merely refills below the peak earns nothing; only new money above it does.
// NAV moves never matter (this is principal, not market value).
//
//   netPrincipal(T) = Σ over the agent's linked investors in the fund, for
//                     executed txns on/after each investor's sourced_on
//                     through T, of (BUY amount − SELL amount)
//   peak            = running maximum of netPrincipal
//   increment       = max(0, peak − storedWatermark)
//   upfront         = increment × upfrontPct
//   newWatermark    = max(storedWatermark, peak)
//
// Idempotent: re-running a period finds peak ≤ watermark → increment 0.

import type { PrismaClient } from "@/generated/prisma";

export type WmTxn = { date: Date; direction: "BUY" | "SELL"; amount: number };

export type WatermarkResult = {
  /** Running peak of net principal reached through the window. */
  peak: number;
  /** Net principal at the window end (after redemptions). */
  netPrincipal: number;
  /** New money above the stored watermark (the upfront base). */
  increment: number;
  /** increment × upfrontPct. */
  upfront: number;
  /** Watermark to persist after this run. */
  newWatermark: number;
  txCount: number;
};

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Pure: replay net principal, track the running peak, pay on any new high
 *  above the stored watermark. `txns` should already be limited to the
 *  evaluation window end; order doesn't matter (sorted here). */
export function computeWatermarkUpfront(
  txns: WmTxn[],
  storedWatermark: number,
  upfrontPct: number,
): WatermarkResult {
  const sorted = [...txns].sort((a, b) => +a.date - +b.date);
  let running = 0;
  let peak = 0;
  for (const t of sorted) {
    running += t.direction === "BUY" ? t.amount : -t.amount;
    if (running > peak) peak = running;
  }
  const newWatermark = Math.max(storedWatermark, peak);
  const increment = r2(Math.max(0, newWatermark - storedWatermark));
  return {
    peak: r2(peak),
    netPrincipal: r2(running),
    increment,
    upfront: r2(increment * upfrontPct),
    newWatermark: r2(newWatermark),
    txCount: sorted.length,
  };
}

/**
 * Fetch the agent's executed fund transactions grouped by fundCode, each
 * gated to on/after that investor's sourced_on and through `throughDate`.
 * Mirrors the portal queries in agent-commission-preview.ts.
 */
export async function fetchAgentFundTxns(
  prisma: PrismaClient,
  agentId: string,
  throughDate: Date,
): Promise<Map<string, WmTxn[]>> {
  const out = new Map<string, WmTxn[]>();
  const agent = await prisma.sellingAgent.findUnique({
    where: { id: agentId },
    include: { investors: true },
  });
  if (!agent || agent.investors.length === 0) return out;

  const investorCodes = Array.from(new Set(agent.investors.map((l) => l.investorCode)));
  const portalInvestors = await prisma.$queryRawUnsafe<Array<{ id: string; investorCode: string }>>(
    `SELECT id, "investorCode" FROM public.investors WHERE "investorCode" = ANY($1::text[])`,
    investorCodes,
  );
  const portalFunds = await prisma.$queryRawUnsafe<Array<{ id: string; code: string }>>(
    `SELECT id, code FROM public.funds`,
  );
  const codeByInvId = new Map(portalInvestors.map((i) => [i.id, i.investorCode]));
  const codeByFundId = new Map(portalFunds.map((f) => [f.id, f.code]));
  const invIds = portalInvestors.map((i) => i.id);
  const fundIds = portalFunds.map((f) => f.id);
  if (invIds.length === 0 || fundIds.length === 0) return out;

  // Earliest sourced_on per (investorCode, fundCode) — gates pre-sourcing txns.
  // Direct subscriptions earn no agent commission (clause 6.5), so a pair only
  // counts toward the watermark if it has at least one non-direct link.
  const sourcedByPair = new Map<string, Date>();
  const eligiblePairs = new Set<string>();
  for (const l of agent.investors) {
    const key = `${l.investorCode}|${l.fundCode}`;
    const cur = sourcedByPair.get(key);
    if (!cur || l.sourcedOn < cur) sourcedByPair.set(key, l.sourcedOn);
    if (!l.isDirectSubscription) eligiblePairs.add(key);
  }

  const rows = await prisma.$queryRawUnsafe<
    Array<{ investorId: string; fundId: string; date: Date; direction: string; amount: unknown }>
  >(
    `SELECT "investorId", "fundId", "orderDate" AS date, direction, amount
     FROM public.transactions
     WHERE "investorId" = ANY($1::text[]) AND "fundId" = ANY($2::text[])
       AND status = 'EXECUTED' AND "orderDate" <= $3
     ORDER BY "orderDate" ASC, "createdAt" ASC`,
    invIds,
    fundIds,
    throughDate,
  );

  for (const t of rows) {
    const invCode = codeByInvId.get(t.investorId);
    const fundCode = codeByFundId.get(t.fundId);
    if (!invCode || !fundCode) continue;
    const pairKey = `${invCode}|${fundCode}`;
    if (!eligiblePairs.has(pairKey)) continue; // not linked / direct subscription (no commission)
    const sourcedOn = sourcedByPair.get(pairKey);
    if (!sourcedOn || t.date < sourcedOn) continue; // pre-sourcing
    const dir = t.direction === "BUY" ? "BUY" : "SELL";
    const arr = out.get(fundCode) ?? [];
    arr.push({ date: t.date, direction: dir, amount: Number(t.amount ?? 0) });
    out.set(fundCode, arr);
  }
  return out;
}
