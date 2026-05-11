// Annexure-B (Investments) — per spec §5.11 Annexure march sheet.
// Reads InvestmentHolding rows for a fiscal year and groups them by
// category, computing per-row totalCost / marketValue / unrealisedGain
// and per-category subtotals.
//
// The sum of unrealised G/L across all categories feeds the IS OCI
// (unrealisedFairValueLoss). Until holdings are entered, the sum is 0
// and the IS/BS/Notes pages fall back to query-string overrides.

import { prisma } from "@/lib/prisma";
import type { InvestmentCategory } from "@/generated/prisma";

export type AnnexureRow = {
  id: string;
  category: InvestmentCategory;
  instrumentName: string;
  quantity: number;
  avgCostPerUnit: number;
  totalCost: number;
  marketRatePerUnit: number | null;
  marketValue: number | null;
  unrealisedGain: number | null;
  notes: string | null;
};

export type AnnexureGroup = {
  category: InvestmentCategory;
  label: string;
  rows: AnnexureRow[];
  subtotals: {
    totalCost: number;
    marketValue: number;
    unrealisedGain: number;
  };
};

export type AnnexureB = {
  asOfDate: Date | null;
  groups: AnnexureGroup[];
  totals: {
    totalCost: number;
    marketValue: number;
    unrealisedGain: number;
  };
};

const CATEGORY_ORDER: InvestmentCategory[] = [
  "listed_securities",
  "open_end_mutual_funds",
  "ipo_subscription",
  "ipo_applications",
  "private_placements",
];

const CATEGORY_LABELS: Record<InvestmentCategory, string> = {
  listed_securities: "Listed Securities",
  open_end_mutual_funds: "Open-End Mutual Funds",
  ipo_subscription: "IPO Subscription",
  ipo_applications: "IPO Applications",
  private_placements: "Private Placements",
};

export function categoryLabel(c: InvestmentCategory): string {
  return CATEGORY_LABELS[c];
}

/**
 * Builds Annexure-B for the given fiscal year. Uses the most recent
 * `asOfDate` available (the workbook captures a single date per period).
 */
export async function getAnnexureB(fiscalYearId: string): Promise<AnnexureB> {
  const holdings = await prisma.investmentHolding.findMany({
    where: { fiscalYearId },
    orderBy: [{ asOfDate: "desc" }, { category: "asc" }, { instrumentName: "asc" }],
  });

  if (holdings.length === 0) {
    return {
      asOfDate: null,
      groups: CATEGORY_ORDER.map((c) => ({
        category: c,
        label: CATEGORY_LABELS[c],
        rows: [],
        subtotals: { totalCost: 0, marketValue: 0, unrealisedGain: 0 },
      })),
      totals: { totalCost: 0, marketValue: 0, unrealisedGain: 0 },
    };
  }

  const latestAsOf = holdings[0].asOfDate;
  const latest = holdings.filter(
    (h) => h.asOfDate.getTime() === latestAsOf.getTime(),
  );

  const byCategory = new Map<InvestmentCategory, AnnexureRow[]>();
  for (const c of CATEGORY_ORDER) byCategory.set(c, []);

  for (const h of latest) {
    const quantity = Number(h.quantity);
    const avgCost = Number(h.avgCostPerUnit);
    const marketRate = h.marketRatePerUnit === null ? null : Number(h.marketRatePerUnit);
    const totalCost = quantity * avgCost;
    const marketValue = marketRate === null ? null : quantity * marketRate;
    const unrealisedGain = marketValue === null ? null : marketValue - totalCost;
    byCategory.get(h.category)!.push({
      id: h.id,
      category: h.category,
      instrumentName: h.instrumentName,
      quantity,
      avgCostPerUnit: avgCost,
      totalCost,
      marketRatePerUnit: marketRate,
      marketValue,
      unrealisedGain,
      notes: h.notes,
    });
  }

  const groups: AnnexureGroup[] = CATEGORY_ORDER.map((c) => {
    const rows = byCategory.get(c) ?? [];
    const subtotals = rows.reduce(
      (s, r) => ({
        totalCost: s.totalCost + r.totalCost,
        marketValue: s.marketValue + (r.marketValue ?? 0),
        unrealisedGain: s.unrealisedGain + (r.unrealisedGain ?? 0),
      }),
      { totalCost: 0, marketValue: 0, unrealisedGain: 0 },
    );
    return { category: c, label: CATEGORY_LABELS[c], rows, subtotals };
  });

  const totals = groups.reduce(
    (s, g) => ({
      totalCost: s.totalCost + g.subtotals.totalCost,
      marketValue: s.marketValue + g.subtotals.marketValue,
      unrealisedGain: s.unrealisedGain + g.subtotals.unrealisedGain,
    }),
    { totalCost: 0, marketValue: 0, unrealisedGain: 0 },
  );

  return { asOfDate: latestAsOf, groups, totals };
}

/**
 * Sum of unrealised losses (positive amount) across all holdings —
 * what IS!OCI / Note 24 calls `unrealisedFairValueLoss`. A net gain
 * returns 0; the OCI line only takes the negative side per spec.
 * Returns 0 silently if the investment_holdings table is missing (i.e.
 * the schema migration hasn't been applied yet) — keeps IS/BS/Notes
 * pages working pre-migration.
 */
export async function getUnrealisedFairValueLoss(fiscalYearId: string): Promise<number> {
  try {
    const annexure = await getAnnexureB(fiscalYearId);
    return annexure.totals.unrealisedGain < 0 ? -annexure.totals.unrealisedGain : 0;
  } catch {
    return 0;
  }
}
