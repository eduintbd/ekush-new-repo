// Read-only access to portal-owned tables (public.investors, public.funds,
// public.fund_holdings) via raw SQL. We keep these out of the Prisma model
// graph so `prisma db push` never touches the portal's schema — the
// X-System only manages xsystem.*.
//
// All functions are pure reads. If the X-System ever needs to write back to
// public.*, it should go through the portal's HTTP API, not direct DB write.

import { prisma } from "@/lib/prisma";

// ─── Types matching the portal's public.* column shapes ──────────

export type PortalInvestor = {
  id: string;
  investorCode: string | null;
  name: string | null;
  title: string | null;
  investorType: string | null;
  boId: string | null;
  brokerageHouse: string | null;
  dpId: string | null;
};

export type PortalFund = {
  id: string;
  code: string;
  name: string;
};

export type PortalFundHolding = {
  investorId: string;
  fundId: string;
  totalCurrentUnits: number;
  totalUnitsBought: number;
  totalUnitsSold: number;
  avgCost: number;
  nav: number;
  totalMarketValue: number;
  totalRealizedGain: number;
  totalUnrealizedGain: number;
  firstPurchaseDate: Date | null;
};

// ─── Lookup helpers ──────────────────────────────────────────────

/**
 * Look up investor rows by investorCode. Returns a Map keyed on
 * investorCode for easy joining.
 */
export async function getInvestorsByCode(
  codes: string[],
): Promise<Map<string, PortalInvestor>> {
  if (codes.length === 0) return new Map();
  const rows = await prisma.$queryRawUnsafe<PortalInvestor[]>(
    `SELECT id, "investorCode", name, title, "investorType", "boId",
            "brokerageHouse", "dpId"
     FROM public.investors
     WHERE "investorCode" = ANY($1::text[])`,
    codes,
  );
  return new Map(rows.map((r) => [r.investorCode ?? "", r]));
}

/**
 * All funds keyed by code (EFUF / EGF / ESRF).
 */
export async function getAllFunds(): Promise<Map<string, PortalFund>> {
  const rows = await prisma.$queryRawUnsafe<PortalFund[]>(
    `SELECT id, code, name FROM public.funds`,
  );
  return new Map(rows.map((r) => [r.code, r]));
}

/**
 * Fund holdings for a set of (investorId, fundId) pairs. Returns a Map
 * keyed on `${investorId}|${fundId}`.
 */
export async function getHoldings(
  pairs: Array<{ investorId: string; fundId: string }>,
): Promise<Map<string, PortalFundHolding>> {
  if (pairs.length === 0) return new Map();
  const investorIds = Array.from(new Set(pairs.map((p) => p.investorId)));
  const fundIds = Array.from(new Set(pairs.map((p) => p.fundId)));
  const rows = await prisma.$queryRawUnsafe<PortalFundHolding[]>(
    `SELECT "investorId", "fundId",
            "totalCurrentUnits", "totalUnitsBought", "totalUnitsSold",
            "avgCost", nav, "totalMarketValue",
            "totalRealizedGain", "totalUnrealizedGain", "firstPurchaseDate"
     FROM public.fund_holdings
     WHERE "investorId" = ANY($1::text[]) AND "fundId" = ANY($2::text[])`,
    investorIds,
    fundIds,
  );
  return new Map(rows.map((r) => [`${r.investorId}|${r.fundId}`, r]));
}

export type PortalRedemption = {
  investorId: string;
  fundId: string;
  date: Date;
  units: number;
  gross: number;
  channel: string; // 'LS' (lump-sum) | 'SIP'
};

/**
 * Executed SELL transactions for a set of (investorId, fundId) pairs,
 * optionally filtered to those at-or-after `sinceDate`.
 *
 * The commission engine needs these for:
 *   - Clawback: redemptions within (sourced_on + clawback_months) trigger
 *     a clawback on the upfront. Engine internally filters by deadline.
 *   - Trail: redeemed units stop earning trail from the redemption date.
 *     Engine recomputes outstanding units per week.
 */
export async function getRedemptions(
  pairs: Array<{ investorId: string; fundId: string }>,
  sinceDate?: Date,
): Promise<Map<string, PortalRedemption[]>> {
  if (pairs.length === 0) return new Map();
  const investorIds = Array.from(new Set(pairs.map((p) => p.investorId)));
  const fundIds = Array.from(new Set(pairs.map((p) => p.fundId)));
  // Note: we filter at the application layer for (investorId, fundId)
  // matching since Postgres ANY() doesn't AND across two arrays.
  // First pull all SELL rows for any of the investors + funds, then filter.
  const rows = await prisma.$queryRawUnsafe<PortalRedemption[]>(
    `SELECT "investorId", "fundId", "orderDate" AS date,
            units, amount AS gross, channel
     FROM public.transactions
     WHERE direction = 'SELL'
       AND status = 'EXECUTED'
       AND "investorId" = ANY($1::text[])
       AND "fundId" = ANY($2::text[])
       ${sinceDate ? `AND "orderDate" >= $3` : ""}
     ORDER BY "orderDate" ASC`,
    investorIds,
    fundIds,
    ...(sinceDate ? [sinceDate] : []),
  );
  // Bucket by (investorId|fundId), keeping only pairs that were requested
  const wantedPairs = new Set(pairs.map((p) => `${p.investorId}|${p.fundId}`));
  const out = new Map<string, PortalRedemption[]>();
  for (const r of rows) {
    const key = `${r.investorId}|${r.fundId}`;
    if (!wantedPairs.has(key)) continue;
    const arr = out.get(key) ?? [];
    arr.push(r);
    out.set(key, arr);
  }
  return out;
}

/**
 * Full investor list for the link-investor-to-agent dropdown. Returns a
 * lightweight projection — name + investorCode + a few admin fields so
 * the dropdown is searchable.
 */
export async function listInvestorsForPicker(limit = 1000): Promise<PortalInvestor[]> {
  const rows = await prisma.$queryRawUnsafe<PortalInvestor[]>(
    `SELECT id, "investorCode", name, title, "investorType", "boId",
            "brokerageHouse", "dpId"
     FROM public.investors
     WHERE "investorCode" IS NOT NULL
     ORDER BY "investorCode"
     LIMIT $1`,
    limit,
  );
  return rows;
}
