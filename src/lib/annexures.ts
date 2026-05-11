// Annexure-A (PPE register) + Annexure-B (Investments) — per spec §5.11.
//
// Annexure-A reads FixedAsset + FixedAssetDepreciation grouped by asset class.
// Annexure-B reads InvestmentHolding grouped by category. The sum of
// unrealised G/L across categories feeds the IS OCI (unrealisedFairValueLoss).

import { prisma } from "@/lib/prisma";
import type { AssetClass, InvestmentCategory } from "@/generated/prisma";

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

// ─── Annexure-A (PPE register) ───────────────────────────────────

const ASSET_CLASS_ORDER: AssetClass[] = [
  "computers",
  "office_decoration",
  "office_equipment",
  "other",
];

const ASSET_CLASS_LABEL: Record<AssetClass, string> = {
  computers: "Computers",
  office_decoration: "Office Decoration",
  office_equipment: "Office Equipment",
  other: "Other",
};

export type AnnexureARow = {
  id: string;
  name: string;
  acquiredOn: Date;
  cost: number;
  /** Running accumulated depreciation through the period end. */
  accumulatedDepreciation: number;
  /** Depreciation charged in the report's FY (from FixedAssetDepreciation). */
  periodDepreciation: number;
  /** cost − accumulatedDepreciation */
  wdv: number;
  depreciationRatePctPa: number | null;
  disposedOn: Date | null;
};

export type AnnexureAGroup = {
  assetClass: AssetClass;
  label: string;
  rows: AnnexureARow[];
  subtotals: {
    cost: number;
    accumulatedDepreciation: number;
    periodDepreciation: number;
    wdv: number;
  };
};

export type AnnexureA = {
  groups: AnnexureAGroup[];
  totals: {
    cost: number;
    accumulatedDepreciation: number;
    periodDepreciation: number;
    wdv: number;
  };
};

const EMPTY_A: AnnexureA = {
  groups: ASSET_CLASS_ORDER.map((c) => ({
    assetClass: c,
    label: ASSET_CLASS_LABEL[c],
    rows: [],
    subtotals: { cost: 0, accumulatedDepreciation: 0, periodDepreciation: 0, wdv: 0 },
  })),
  totals: { cost: 0, accumulatedDepreciation: 0, periodDepreciation: 0, wdv: 0 },
};

/**
 * PPE register for the given fiscal year, grouped by asset class. Returns
 * an empty (zero-row) shell if the FixedAsset table is missing (pre-migration)
 * or if no assets have been entered yet — page renders an inputs-needed banner.
 */
export async function getAnnexureA(fiscalYearId: string): Promise<AnnexureA> {
  let assets;
  let depreciations;
  try {
    [assets, depreciations] = await Promise.all([
      prisma.fixedAsset.findMany({
        orderBy: [{ assetClass: "asc" }, { acquiredOn: "asc" }],
      }),
      prisma.fixedAssetDepreciation.findMany({
        where: { fiscalYearId },
        select: { fixedAssetId: true, amount: true },
      }),
    ]);
  } catch {
    return EMPTY_A;
  }

  if (assets.length === 0) return EMPTY_A;

  const depByAsset = new Map(
    depreciations.map((d) => [d.fixedAssetId, Number(d.amount)]),
  );

  const byClass = new Map<AssetClass, AnnexureARow[]>();
  for (const c of ASSET_CLASS_ORDER) byClass.set(c, []);

  for (const a of assets) {
    const cost = Number(a.cost);
    const accumulatedDepreciation = Number(a.accumulatedDepreciation);
    const periodDepreciation = depByAsset.get(a.id) ?? 0;
    const row: AnnexureARow = {
      id: a.id,
      name: a.name,
      acquiredOn: a.acquiredOn,
      cost,
      accumulatedDepreciation,
      periodDepreciation,
      wdv: cost - accumulatedDepreciation,
      depreciationRatePctPa: a.depreciationRatePctPa === null ? null : Number(a.depreciationRatePctPa),
      disposedOn: a.disposedOn,
    };
    byClass.get(a.assetClass)!.push(row);
  }

  const groups: AnnexureAGroup[] = ASSET_CLASS_ORDER.map((c) => {
    const rows = byClass.get(c) ?? [];
    const subtotals = rows.reduce(
      (s, r) => ({
        cost: s.cost + r.cost,
        accumulatedDepreciation: s.accumulatedDepreciation + r.accumulatedDepreciation,
        periodDepreciation: s.periodDepreciation + r.periodDepreciation,
        wdv: s.wdv + r.wdv,
      }),
      { cost: 0, accumulatedDepreciation: 0, periodDepreciation: 0, wdv: 0 },
    );
    return { assetClass: c, label: ASSET_CLASS_LABEL[c], rows, subtotals };
  });

  const totals = groups.reduce(
    (s, g) => ({
      cost: s.cost + g.subtotals.cost,
      accumulatedDepreciation: s.accumulatedDepreciation + g.subtotals.accumulatedDepreciation,
      periodDepreciation: s.periodDepreciation + g.subtotals.periodDepreciation,
      wdv: s.wdv + g.subtotals.wdv,
    }),
    { cost: 0, accumulatedDepreciation: 0, periodDepreciation: 0, wdv: 0 },
  );

  return { groups, totals };
}
