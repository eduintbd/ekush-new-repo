// GET /api/agent/statements?code=A00005&type=portfolio|transactions|dividends|tax&fundCode=EFUF
// Returns a statement PDF for one of the signed-in agent's investors, generated
// from the shared DB. Agent-scoped: refuses codes not linked to this agent.

import type { NextRequest } from "next/server";
import { getAgentScope } from "@/lib/agent-scope";
import { getInvestorProfileByCode } from "@/lib/portal-investor";
import {
  getTransactionRows,
  getDividendRows,
  getTaxCertRows,
  getInvestmentUpdateRows,
} from "@/lib/portal-statements";
import { transactionsPdf, dividendsPdf, taxCertPdf } from "@/lib/agent-pdf";
import {
  investmentUpdatePdf,
  getPortfolioBannerDataUrl,
  statementDateStr,
} from "@/lib/investment-update-pdf";
import { accountHolderName } from "@/lib/account-name";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const scope = await getAgentScope();
  const { searchParams } = new URL(req.url);
  const code = (searchParams.get("code") ?? "").trim();
  const type = (searchParams.get("type") ?? "portfolio").trim();
  const fundCode = (searchParams.get("fundCode") ?? "").trim() || undefined;

  if (!code || !scope.codeSet.has(code)) {
    return new Response("Not authorized for this investor.", { status: 403 });
  }
  const investor = await getInvestorProfileByCode(code);
  if (!investor) return new Response("Investor not found.", { status: 404 });

  const inv = {
    name: investor.name,
    investorCode: investor.investorCode,
    jointApplicantName: investor.jointApplicantName,
  };

  let pdf: Uint8Array;
  let label: string;
  switch (type) {
    case "transactions":
      pdf = transactionsPdf(inv, await getTransactionRows(investor.id, fundCode), fundCode);
      label = "Transactions";
      break;
    case "dividends":
      pdf = dividendsPdf(inv, await getDividendRows(investor.id, fundCode), fundCode);
      label = "Dividends";
      break;
    case "tax":
      pdf = taxCertPdf(inv, await getTaxCertRows(investor.id, fundCode), fundCode);
      label = "TaxCertificate";
      break;
    case "portfolio":
    default: {
      // The branded one-page statement per fund — the same document the
      // portal issues, not a generic table dump. See investment-update-pdf.ts.
      const rows = await getInvestmentUpdateRows(investor.id, fundCode);
      const banner = getPortfolioBannerDataUrl() ?? undefined;
      const dateStr = statementDateStr();
      pdf = investmentUpdatePdf(
        inv,
        rows.map((r) => ({
          investorName: accountHolderName(inv),
          investorCode: inv.investorCode,
          fundName: r.fundName,
          fundCode: r.fundCode,
          totalUnits: Number(r.totalUnits),
          avgCost: Number(r.avgCost),
          costValue: Number(r.costValue),
          marketValue: Number(r.marketValue),
          realizedGain: Number(r.realizedGain),
          dividendTotal: Number(r.dividendTotal),
          nav: Number(r.nav),
          entryLoad: Number(r.entryLoad),
          exitLoad: Number(r.exitLoad),
          dateStr,
          bannerPngDataUrl: banner,
        })),
      );
      label = "Statement";
      break;
    }
  }

  const filename = `${label}-${code}${fundCode ? "-" + fundCode : ""}.pdf`;
  // Cast: undici's Response accepts a Uint8Array body at runtime; the TS 5.7
  // typed-array generic (Uint8Array<ArrayBufferLike>) just doesn't match BodyInit.
  return new Response(pdf as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
