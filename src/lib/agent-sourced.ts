// Agent-sourced investors: those an agent onboarded via /agent/investors/new,
// identified by sourcingAgentCode in the REGISTRATION KycRecord snapshot.
//
// Three jobs:
//  1. getAgentSourcedInvestors — list them for the agent's own portal, so a
//     freshly-onboarded investor is visible even before any commission link.
//  2. reconcileAgentInvestorLinks, pass A — once such an investor actually
//     invests (a BUY transaction in a fund exists), create the
//     xsystem.agent_investors link so the commission engine + the agent's list
//     pick them up. The link can't be made at approval because it needs the
//     fund + first-investment data, which don't exist until the investor buys.
//  3. reconcileAgentInvestorLinks, pass B — backfill links that were created
//     with zero initial units. Admin can link a SIP investor before they have
//     bought anything (see linkInvestorToAgent), which parks a placeholder row
//     at 0 units / 0 price. Pass A can never revisit it: it starts from the
//     REGISTRATION KYC snapshot's sourcingAgentCode, and a hand-linked
//     investor usually carries no such marker; it also skips any (investor,
//     fund) pair that is already linked. So pass B works off the links
//     themselves instead of the snapshot.

import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma";

export interface SourcedInvestor {
  investorCode: string;
  name: string;
  status: string; // portal user status (PENDING / ACTIVE / …)
  createdAt: Date;
}

// A MATERIALIZED CTE filters to JSON-object snapshots BEFORE the ->> cast so a
// stray non-JSON REGISTRATION row can never fail the whole query.
export async function getAgentSourcedInvestors(agentCode: string): Promise<SourcedInvestor[]> {
  return prisma.$queryRawUnsafe<SourcedInvestor[]>(
    `WITH s AS MATERIALIZED (
       SELECT i."investorCode" AS "investorCode", i.name AS name, u.status AS status,
              i."createdAt" AS "createdAt", k."documentUrl" AS snap
       FROM public.kyc_records k
       JOIN public.investors i ON i.id = k."investorId"
       JOIN public.users u ON u.id = i."userId"
       WHERE k.type = 'REGISTRATION' AND k."documentUrl" LIKE '{%'
     )
     SELECT "investorCode", name, status, "createdAt"
     FROM s
     WHERE (snap::jsonb ->> 'sourcingAgentCode') = $1
     ORDER BY "createdAt" DESC`,
    agentCode,
  );
}

interface FirstBuy {
  code: string;
  fundCode: string;
  sourcedOn: Date;
  units: number;
  amount: number;
  nav: number;
}

/** First executed BUY per (investor, fund) for the given investor codes. */
async function firstExecutedBuys(investorCodes: string[]): Promise<FirstBuy[]> {
  if (investorCodes.length === 0) return [];
  return prisma.$queryRawUnsafe<FirstBuy[]>(
    `SELECT DISTINCT ON (i."investorCode", f.code)
            i."investorCode" AS code, f.code AS "fundCode",
            t."orderDate" AS "sourcedOn", t.units AS units, t.amount AS amount, t.nav AS nav
     FROM public.transactions t
     JOIN public.investors i ON i.id = t."investorId"
     JOIN public.funds f ON f.id = t."fundId"
     WHERE t.direction = 'BUY' AND t.status = 'EXECUTED'
       AND i."investorCode" = ANY($1::text[])
     ORDER BY i."investorCode", f.code, t."orderDate" ASC`,
    investorCodes,
  );
}

/** Unit price actually paid: the recorded NAV, else derived from the money. */
function priceOf(b: FirstBuy): { units: number; amount: number; price: number } {
  const units = Number(b.units) || 0;
  const amount = Number(b.amount) || 0;
  return { units, amount, price: Number(b.nav) || (units > 0 ? amount / units : 0) };
}

/**
 * Create agent_investors links for agent-sourced investors who have since
 * invested, and fill in any placeholder link still sitting at zero units.
 * Idempotent (skips existing non-zero links; a (code,fund,sourcedOn) unique
 * index backstops races). Returns how many links were created and backfilled.
 */
export async function reconcileAgentInvestorLinks(): Promise<{
  created: number;
  backfilled: number;
  scanned: number;
}> {
  // 1. Map ACTIVE, real-code, agent-sourced investors → sourcing agent code.
  const sourced = await prisma.$queryRawUnsafe<{ code: string; agentCode: string }[]>(
    `WITH s AS MATERIALIZED (
       SELECT i."investorCode" AS code, u.status AS status, k."documentUrl" AS snap
       FROM public.kyc_records k
       JOIN public.investors i ON i.id = k."investorId"
       JOIN public.users u ON u.id = i."userId"
       WHERE k.type = 'REGISTRATION' AND k."documentUrl" LIKE '{%'
     )
     SELECT code, (snap::jsonb ->> 'sourcingAgentCode') AS "agentCode"
     FROM s
     WHERE (snap::jsonb ->> 'sourcingAgentCode') IS NOT NULL
       AND status = 'ACTIVE'
       AND code NOT LIKE 'PENDING-%'`,
  );
  // Pass B stands on its own — it reads the links, not the snapshot — so an
  // empty pass-A candidate list must not skip it.
  if (sourced.length === 0) {
    return { created: 0, backfilled: await backfillZeroUnitLinks(), scanned: 0 };
  }

  const agentCodeByInvestor = new Map(sourced.map((r) => [r.code, r.agentCode]));
  const investorCodes = Array.from(agentCodeByInvestor.keys());

  // 2. Resolve sourcing agent codes → approved agent ids.
  const agents = await prisma.sellingAgent.findMany({
    where: { code: { in: Array.from(new Set(sourced.map((r) => r.agentCode))) }, status: { in: ["approved", "suspended"] } },
    select: { id: true, code: true },
  });
  const agentIdByCode = new Map(agents.map((a) => [a.code, a.id]));

  // 3. First executed BUY per (investor, fund).
  const firstBuys = await firstExecutedBuys(investorCodes);

  // 4. Existing links, to skip.
  const existing = await prisma.agentInvestor.findMany({
    where: { investorCode: { in: investorCodes } },
    select: { investorCode: true, fundCode: true },
  });
  const linked = new Set(existing.map((e) => `${e.investorCode}|${e.fundCode}`));

  let created = 0;
  for (const b of firstBuys) {
    if (linked.has(`${b.code}|${b.fundCode}`)) continue;
    const agentCode = agentCodeByInvestor.get(b.code);
    const agentId = agentCode ? agentIdByCode.get(agentCode) : undefined;
    if (!agentId) continue;
    const { units, amount, price } = priceOf(b);
    try {
      await prisma.agentInvestor.create({
        data: {
          agentId,
          investorCode: b.code,
          fundCode: b.fundCode,
          sourcedOn: b.sourcedOn,
          initialUnits: units,
          initialGrossAmount: amount,
          unitPriceAtSourcing: price,
          isDirectSubscription: false,
        },
      });
      created++;
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
    }
  }

  return { created, backfilled: await backfillZeroUnitLinks(), scanned: firstBuys.length };
}

/**
 * Fill in links parked at zero initial units — the placeholder an admin
 * creates when linking a SIP investor who has not bought yet — from that
 * investor's first executed BUY. Returns how many rows were filled.
 *
 * `sourcedOn` is deliberately left alone. It records when the AGENT sourced
 * the investor, which the admin chose on purpose and which is not the same
 * date the money arrived; holding it still also keeps the row clear of the
 * (investorCode, fundCode, sourcedOn) unique index. Rows carrying a non-zero
 * figure are never touched, so a hand-entered number always wins.
 */
async function backfillZeroUnitLinks(): Promise<number> {
  const placeholders = await prisma.agentInvestor.findMany({
    where: { initialUnits: 0 },
    select: { id: true, investorCode: true, fundCode: true },
  });
  if (placeholders.length === 0) return 0;

  const buys = await firstExecutedBuys(
    Array.from(new Set(placeholders.map((p) => p.investorCode))),
  );
  const buyByPair = new Map(buys.map((b) => [`${b.code}|${b.fundCode}`, b]));

  let backfilled = 0;
  for (const p of placeholders) {
    const buy = buyByPair.get(`${p.investorCode}|${p.fundCode}`);
    if (!buy) continue; // still hasn't bought — leave the placeholder standing
    const { units, amount, price } = priceOf(buy);
    if (units <= 0) continue; // nothing worth writing back
    await prisma.agentInvestor.update({
      where: { id: p.id },
      data: {
        initialUnits: units,
        initialGrossAmount: amount,
        unitPriceAtSourcing: price,
      },
    });
    backfilled++;
  }
  return backfilled;
}
