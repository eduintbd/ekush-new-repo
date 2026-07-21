// Read-only raw-SQL reads of the portal's per-investor statement data
// (fund_holdings, transactions, dividends, tax_certificates) joined with the
// fund code/name. Used to generate the agent-facing statement PDFs off the
// shared DB. Callers must gate the investor by agent scope first.

import { prisma } from "@/lib/prisma";

export interface HoldingRow {
  fundCode: string;
  fundName: string;
  totalCurrentUnits: number;
  avgCost: number;
  nav: number;
  totalCostValueCurrent: number;
  totalMarketValue: number;
  totalUnrealizedGain: number;
  totalRealizedGain: number;
  grossDividend: number;
  firstPurchaseDate: Date | null;
}

export async function getHoldingRows(investorId: string, fundCode?: string): Promise<HoldingRow[]> {
  const args: unknown[] = [investorId];
  if (fundCode) args.push(fundCode);
  return prisma.$queryRawUnsafe<HoldingRow[]>(
    `SELECT f.code AS "fundCode", f.name AS "fundName",
            h."totalCurrentUnits", h."avgCost", h.nav, h."totalCostValueCurrent",
            h."totalMarketValue", h."totalUnrealizedGain", h."totalRealizedGain",
            h."grossDividend", h."firstPurchaseDate"
     FROM public.fund_holdings h
     JOIN public.funds f ON f.id = h."fundId"
     WHERE h."investorId" = $1 ${fundCode ? 'AND f.code = $2' : ""}
     ORDER BY f.code`,
    ...args,
  );
}

export interface TxnRow {
  fundCode: string;
  orderDate: Date;
  direction: string;
  channel: string;
  units: number;
  nav: number;
  amount: number;
  cumulativeUnits: number;
}

export async function getTransactionRows(investorId: string, fundCode?: string): Promise<TxnRow[]> {
  const args: unknown[] = [investorId];
  if (fundCode) args.push(fundCode);
  return prisma.$queryRawUnsafe<TxnRow[]>(
    `SELECT f.code AS "fundCode", t."orderDate", t.direction, t.channel,
            t.units, t.nav, t.amount, t."cumulativeUnits"
     FROM public.transactions t
     JOIN public.funds f ON f.id = t."fundId"
     WHERE t."investorId" = $1 AND t.status = 'EXECUTED' ${fundCode ? 'AND f.code = $2' : ""}
     ORDER BY t."orderDate" ASC`,
    ...args,
  );
}

export interface DividendRow {
  fundCode: string;
  accountingYear: string | null;
  paymentDate: Date | null;
  totalUnits: number;
  dividendPerUnit: number;
  grossDividend: number;
  taxAmount: number;
  netDividend: number;
}

export async function getDividendRows(investorId: string, fundCode?: string): Promise<DividendRow[]> {
  const args: unknown[] = [investorId];
  if (fundCode) args.push(fundCode);
  return prisma.$queryRawUnsafe<DividendRow[]>(
    `SELECT f.code AS "fundCode", d."accountingYear", d."paymentDate",
            d."totalUnits", d."dividendPerUnit", d."grossDividend",
            d."taxAmount", d."netDividend"
     FROM public.dividends d
     JOIN public.funds f ON f.id = d."fundId"
     WHERE d."investorId" = $1 ${fundCode ? 'AND f.code = $2' : ""}
     ORDER BY d."paymentDate" ASC NULLS LAST`,
    ...args,
  );
}

export interface TaxCertRow {
  fundCode: string;
  periodStart: Date | null;
  periodEnd: Date | null;
  endingUnits: number;
  endingCostValue: number;
  endingMarketValue: number;
  endingUnrealizedGain: number;
  totalRealizedGain: number;
  netInvestment: number;
  totalGrossDividend: number;
  totalTax: number;
  totalNetDividend: number;
}

export async function getTaxCertRows(investorId: string, fundCode?: string): Promise<TaxCertRow[]> {
  const args: unknown[] = [investorId];
  if (fundCode) args.push(fundCode);
  return prisma.$queryRawUnsafe<TaxCertRow[]>(
    `SELECT f.code AS "fundCode", tc."periodStart", tc."periodEnd",
            tc."endingUnits", tc."endingCostValue", tc."endingMarketValue",
            tc."endingUnrealizedGain", tc."totalRealizedGain", tc."netInvestment",
            tc."totalGrossDividend", tc."totalTax", tc."totalNetDividend"
     FROM public.tax_certificates tc
     JOIN public.funds f ON f.id = tc."fundId"
     WHERE tc."investorId" = $1 ${fundCode ? 'AND f.code = $2' : ""}
     ORDER BY tc."periodEnd" DESC NULLS LAST, f.code`,
    ...args,
  );
}

// ─── Investment Update (the branded portfolio statement) ─────────
// Everything the branded one-page statement needs, per fund. Mirrors the
// portal's /forms/investment-update query set exactly (see its page.tsx), so
// the agent's PDF and the portal's page show the same numbers:
//   - units / avgCost / costValue / realizedGain  → public.fund_holdings
//   - nav                                          → latest public.nav_records
//     row for the fund (NOT funds.currentNav, which is a stale cache — it has
//     frozen a fund at its inception value before)
//   - dividendTotal                                → SUM(public.dividends)
//     (fund_holdings.grossDividend is 0 for investors whose dividends predate
//     that column being maintained, so it cannot be used here)
//   - entryLoad / exitLoad                         → public.funds

export interface InvestmentUpdateRow {
  fundCode: string;
  fundName: string;
  totalUnits: number;
  avgCost: number;
  costValue: number;
  marketValue: number;
  realizedGain: number;
  dividendTotal: number;
  nav: number;
  entryLoad: number;
  exitLoad: number;
}

export async function getInvestmentUpdateRows(
  investorId: string,
  fundCode?: string,
): Promise<InvestmentUpdateRow[]> {
  const args: unknown[] = [investorId];
  if (fundCode) args.push(fundCode);
  return prisma.$queryRawUnsafe<InvestmentUpdateRow[]>(
    `SELECT f.code AS "fundCode",
            f.name AS "fundName",
            h."totalCurrentUnits"     AS "totalUnits",
            h."avgCost",
            h."totalCostValueCurrent" AS "costValue",
            h."totalRealizedGain"     AS "realizedGain",
            COALESCE(f."entryLoad", 0) AS "entryLoad",
            COALESCE(f."exitLoad", 0)  AS "exitLoad",
            COALESCE(nav.nav, f."currentNav", h.nav, 0) AS "nav",
            COALESCE(h."totalCurrentUnits", 0) * COALESCE(nav.nav, f."currentNav", h.nav, 0) AS "marketValue",
            COALESCE(div.total, 0) AS "dividendTotal"
       FROM public.fund_holdings h
       JOIN public.funds f ON f.id = h."fundId"
       -- Latest NAV per fund. LATERAL keeps it to one indexed lookup per row.
       LEFT JOIN LATERAL (
         SELECT n.nav FROM public.nav_records n
          WHERE n."fundId" = f.id
          ORDER BY n.date DESC
          LIMIT 1
       ) nav ON TRUE
       LEFT JOIN LATERAL (
         SELECT SUM(d."grossDividend") AS total
           FROM public.dividends d
          WHERE d."investorId" = h."investorId" AND d."fundId" = f.id
       ) div ON TRUE
      WHERE h."investorId" = $1 ${fundCode ? 'AND f.code = $2' : ""}
      ORDER BY f.code`,
    ...args,
  );
}

// ─── Tax certificates (full, for the printable certificate) ──────
// getTaxCertRows above returns a summary for the on-screen table. This returns
// everything `buildTaxCertificateBody` needs, mirroring the portal's print
// page query (apps/portal/src/app/(print)/forms/tax-certificate/page.tsx):
// the cert row joined to its fund and investor.

export interface TaxCertFull {
  id: string;
  investorCode: string;
  investorName: string;
  jointApplicantName: string | null;
  investorTitle: string | null;
  investorType: string | null;
  nidNumber: string | null;
  tinNumber: string | null;
  fundCode: string;
  fundName: string;
  periodStart: Date | null;
  periodEnd: Date | null;
  beginningCostValue: number;
  endingCostValue: number;
  beginningMarketValue: number;
  endingMarketValue: number;
  beginningUnrealizedGain: number;
  endingUnrealizedGain: number;
  totalRealizedGain: number;
  totalAdditionAtCost: number;
  totalRedemptionAtCost: number;
  netInvestment: number;
  totalGrossDividend: number;
  totalTax: number;
  totalNetDividend: number;
  chalanNumber: string | null;
  /** Stored as text in public.tax_certificates, not a date column. */
  chalanDate: string | null;
  dividendMethod: string | null;
}

const TAX_CERT_FULL_SELECT = `
  SELECT tc.id,
         i."investorCode", i.name AS "investorName", i."jointApplicantName",
         i.title AS "investorTitle", i."investorType",
         i."nidNumber", i."tinNumber",
         f.code AS "fundCode", f.name AS "fundName",
         tc."periodStart", tc."periodEnd",
         tc."beginningCostValue", tc."endingCostValue",
         tc."beginningMarketValue", tc."endingMarketValue",
         tc."beginningUnrealizedGain", tc."endingUnrealizedGain",
         tc."totalRealizedGain", tc."totalAdditionAtCost", tc."totalRedemptionAtCost",
         tc."netInvestment", tc."totalGrossDividend", tc."totalTax", tc."totalNetDividend",
         tc."chalanNumber", tc."chalanDate", tc."dividendMethod"
    FROM public.tax_certificates tc
    JOIN public.funds f ON f.id = tc."fundId"
    JOIN public.investors i ON i.id = tc."investorId"`;

/** Every certificate for one investor, newest period first. */
export async function getTaxCertsFull(investorId: string): Promise<TaxCertFull[]> {
  return prisma.$queryRawUnsafe<TaxCertFull[]>(
    `${TAX_CERT_FULL_SELECT}
      WHERE tc."investorId" = $1
      ORDER BY tc."periodEnd" DESC NULLS LAST, f.code`,
    investorId,
  );
}

/**
 * One certificate by id, WITH its investor code so the caller can check the
 * requesting agent actually sourced that investor before rendering it.
 */
export async function getTaxCertById(certId: string): Promise<TaxCertFull | null> {
  const rows = await prisma.$queryRawUnsafe<TaxCertFull[]>(
    `${TAX_CERT_FULL_SELECT} WHERE tc.id = $1 LIMIT 1`,
    certId,
  );
  return rows[0] ?? null;
}
