// Per-fund NAV + CAGR, read from the portal's shared tables. Replicates the
// portal's /api/funds logic so the ERP shows the same CAGR the investor sees on
// the SIP page:
//   - current NAV = latest public.nav_records row by date (NOT funds.currentNav,
//     which is a stale cache)
//   - CAGR = (latest compositeNav / earliest compositeNav) ^ (1/years) − 1,
//     annualised over the composite-NAV history. `null` when there are fewer
//     than two composite-NAV points.

import { prisma } from "@/lib/prisma";

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

export interface FundInfo {
  code: string;
  name: string;
  currentNav: number;
  /** Annualised growth of composite NAV, as a percent (e.g. 12.5). null if unknown. */
  cagr: number | null;
  entryLoad: number;
  exitLoad: number;
  inceptionDate: Date | null;
  /** Span of the CAGR window, for the "based on N years" label. */
  cagrYears: number | null;
}

function calcCagr(
  first: { date: Date; compositeNav: number } | null,
  last: { date: Date; compositeNav: number } | null,
): { cagr: number | null; years: number | null } {
  if (!first || !last) return { cagr: null, years: null };
  const startVal = Number(first.compositeNav);
  const endVal = Number(last.compositeNav);
  if (!startVal || !endVal || startVal <= 0) return { cagr: null, years: null };
  const years = (new Date(last.date).getTime() - new Date(first.date).getTime()) / MS_PER_YEAR;
  if (years <= 0) return { cagr: null, years: null };
  const cagr = (Math.pow(endVal / startVal, 1 / years) - 1) * 100;
  return {
    cagr: Number.isFinite(cagr) ? Number(cagr.toFixed(2)) : null,
    years: Number(years.toFixed(2)),
  };
}

/** All three funds with their live NAV and computed CAGR, keyed by code. */
export async function getFundsWithCagr(): Promise<FundInfo[]> {
  const funds = await prisma.$queryRawUnsafe<
    Array<{
      id: string;
      code: string;
      name: string;
      currentNav: number;
      entryLoad: number;
      exitLoad: number;
      inceptionDate: Date | null;
    }>
  >(
    `SELECT id, code, name,
            COALESCE("currentNav", 0) AS "currentNav",
            COALESCE("entryLoad", 0)  AS "entryLoad",
            COALESCE("exitLoad", 0)   AS "exitLoad",
            "inceptionDate"
       FROM public.funds
      ORDER BY code`,
  );

  const out: FundInfo[] = [];
  for (const f of funds) {
    // Latest NAV by date — the same source the statements and commission engine
    // use, not the stale funds.currentNav cache.
    const latestNav = await prisma.$queryRawUnsafe<Array<{ nav: number }>>(
      `SELECT nav FROM public.nav_records WHERE "fundId" = $1 ORDER BY date DESC LIMIT 1`,
      f.id,
    );
    // CAGR endpoints from the composite-NAV history.
    const [firstComp, lastComp] = await Promise.all([
      prisma.$queryRawUnsafe<Array<{ date: Date; compositeNav: number }>>(
        `SELECT date, "compositeNav" FROM public.nav_records
          WHERE "fundId" = $1 AND "compositeNav" IS NOT NULL ORDER BY date ASC LIMIT 1`,
        f.id,
      ),
      prisma.$queryRawUnsafe<Array<{ date: Date; compositeNav: number }>>(
        `SELECT date, "compositeNav" FROM public.nav_records
          WHERE "fundId" = $1 AND "compositeNav" IS NOT NULL ORDER BY date DESC LIMIT 1`,
        f.id,
      ),
    ]);

    const { cagr, years } = calcCagr(firstComp[0] ?? null, lastComp[0] ?? null);

    out.push({
      code: f.code,
      name: f.name,
      currentNav: Number(latestNav[0]?.nav ?? f.currentNav ?? 0),
      cagr,
      entryLoad: Number(f.entryLoad),
      exitLoad: Number(f.exitLoad),
      inceptionDate: f.inceptionDate ? new Date(f.inceptionDate) : null,
      cagrYears: years,
    });
  }
  return out;
}
