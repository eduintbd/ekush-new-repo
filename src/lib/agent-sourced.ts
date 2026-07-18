// Agent-sourced investors: those an agent onboarded via /agent/investors/new,
// identified by sourcingAgentCode in the REGISTRATION KycRecord snapshot.
//
// Two jobs:
//  1. getAgentSourcedInvestors — list them for the agent's own portal, so a
//     freshly-onboarded investor is visible even before any commission link.
//  2. reconcileAgentInvestorLinks — once such an investor actually invests
//     (a BUY transaction in a fund exists), create the xsystem.agent_investors
//     link so the commission engine + the agent's list pick them up. The link
//     can't be made at approval because it needs the fund + first-investment
//     data, which don't exist until the investor buys.

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

/**
 * Create agent_investors links for agent-sourced investors who have since
 * invested. Idempotent (skips existing links; a (code,fund,sourcedOn) unique
 * index backstops races). Returns how many links were created.
 */
export async function reconcileAgentInvestorLinks(): Promise<{ created: number; scanned: number }> {
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
  if (sourced.length === 0) return { created: 0, scanned: 0 };

  const agentCodeByInvestor = new Map(sourced.map((r) => [r.code, r.agentCode]));
  const investorCodes = Array.from(agentCodeByInvestor.keys());

  // 2. Resolve sourcing agent codes → approved agent ids.
  const agents = await prisma.sellingAgent.findMany({
    where: { code: { in: Array.from(new Set(sourced.map((r) => r.agentCode))) }, status: { in: ["approved", "suspended"] } },
    select: { id: true, code: true },
  });
  const agentIdByCode = new Map(agents.map((a) => [a.code, a.id]));

  // 3. First executed BUY per (investor, fund).
  const firstBuys = await prisma.$queryRawUnsafe<FirstBuy[]>(
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
    const units = Number(b.units) || 0;
    const amount = Number(b.amount) || 0;
    const price = Number(b.nav) || (units > 0 ? amount / units : 0);
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

  return { created, scanned: firstBuys.length };
}
