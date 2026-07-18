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
