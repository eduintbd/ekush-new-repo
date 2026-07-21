// /agent/tax-certificate?id=<certId> — the printable tax certificate, byte
// identical to the one the investor gets at portal.ekushwml.com.
//
// This mirrors the portal's (print)/forms/tax-certificate page rather than
// generating a PDF of our own. The agent's previous "tax certificate" was a
// jsPDF table of every period and every fund, which is not a certificate at
// all — the real document is one fund, one income year, on AMC letterhead.
// Reusing the portal's own `buildTaxCertificateBody` (a pure, dependency-free
// HTML builder, copied verbatim) means the two can never drift.
//
// Save-as-PDF is the same route the investor takes: the portal's download
// button also opens this print page and lets the browser produce the file.
//
// SCOPE: the certId comes from the URL, so it is checked against the agent's
// own investor codes before anything is rendered — an id belonging to someone
// else's investor must not be printable just because it was guessed.

import { redirect } from "next/navigation";
import { getAgentScope, agentOwnsCode } from "@/lib/agent-scope";
import { getTaxCertById } from "@/lib/portal-statements";
import { buildTaxCertificateBody } from "@/lib/tax-certificate-html";
import { accountHolderName } from "@/lib/account-name";
import { PrintButton } from "@/components/print-button";

export const dynamic = "force-dynamic";

function Msg({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: 40, textAlign: "center", color: "#666" }}>{children}</div>;
}

export default async function AgentTaxCertificatePrintPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string }>;
}) {
  const scope = await getAgentScope();
  if (!scope.agentId) redirect("/agent");

  const { id } = await searchParams;
  if (!id) return <Msg>No certificate ID provided.</Msg>;

  const cert = await getTaxCertById(id).catch(() => null);
  if (!cert) return <Msg>Certificate not found.</Msg>;
  if (!agentOwnsCode(scope, cert.investorCode)) return <Msg>Not authorised for this investor.</Msg>;

  const body = buildTaxCertificateBody({
    investorName: accountHolderName({
      name: cert.investorName,
      jointApplicantName: cert.jointApplicantName,
    }),
    investorCode: cert.investorCode,
    investorTitle: cert.investorTitle,
    investorType: cert.investorType,
    nidNumber: cert.nidNumber,
    tinNumber: cert.tinNumber,
    fundCode: cert.fundCode,
    fundName: cert.fundName,
    periodStart: cert.periodStart ? new Date(cert.periodStart) : null,
    periodEnd: cert.periodEnd ? new Date(cert.periodEnd) : null,
    beginningCostValue: Number(cert.beginningCostValue),
    endingCostValue: Number(cert.endingCostValue),
    beginningMarketValue: Number(cert.beginningMarketValue),
    endingMarketValue: Number(cert.endingMarketValue),
    beginningUnrealizedGain: Number(cert.beginningUnrealizedGain),
    endingUnrealizedGain: Number(cert.endingUnrealizedGain),
    totalRealizedGain: Number(cert.totalRealizedGain),
    totalAdditionAtCost: Number(cert.totalAdditionAtCost),
    totalRedemptionAtCost: Number(cert.totalRedemptionAtCost),
    netInvestment: Number(cert.netInvestment),
    totalGrossDividend: Number(cert.totalGrossDividend),
    totalTax: Number(cert.totalTax),
    totalNetDividend: Number(cert.totalNetDividend),
    chalanNumber: cert.chalanNumber ?? null,
    chalanDate: cert.chalanDate ?? null,
    dividendMethod: cert.dividendMethod ?? null,
    // logoDataUrl / qrDataUrl omitted so the browser resolves /ekush-logo.png
    // and /cert-qr.png from public/ — exactly as the portal's print page does.
  });

  return (
    <>
      <style
        dangerouslySetInnerHTML={{
          __html: `
        @media print { body{margin:0;padding:0;-webkit-print-color-adjust:exact;print-color-adjust:exact;} .no-print{display:none!important;} .print-page{width:210mm;min-height:297mm;padding:0;margin:0;box-shadow:none!important;} }
        @page { size: A4 portrait; margin: 0; }
      `,
        }}
      />
      <div className="no-print" style={{ padding: 12, textAlign: "center", background: "#f4f4f5" }}>
        <PrintButton className="rounded-[5px] bg-[#F27023] px-4 py-2 text-[13px] font-semibold text-white hover:bg-[#d9631d]">
          ↓ Save as PDF / Print
        </PrintButton>
      </div>
      <div dangerouslySetInnerHTML={{ __html: body }} />
    </>
  );
}
