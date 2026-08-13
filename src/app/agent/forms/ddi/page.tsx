// /agent/forms/ddi — the Auto Debit Instruction form, for a selling agent.
//
// A faithful port of the portal's own print form
// (apps/portal/src/app/(print)/forms/ddi/page.tsx): same A4 layout, same
// sections, same acknowledgement wording, same fund collection-bank details.
// The investor signs THIS piece of paper, so it must be the same document
// wherever it is printed from.
//
// Two differences, both forced by the agent context:
//
//  1. Authorisation. The portal gates on the investor's own session or a staff
//     role. Here the gate is the agent's scope: the plan's investor must be one
//     the agent sourced. Nothing else can be opened.
//  2. The pull-date line. The portal hardcodes `{debitDay}th day of each month`,
//     which prints "1th" and "21th", and says nothing about days that do not
//     exist in every month. Agents can pick any day, so it uses debitDayLabel().
//
// Two render paths, as the portal has: ?sipPlanId= for a saved plan, and the
// URL-param preview the confirmation modal opens before the plan exists.

import { redirect } from "next/navigation";
import { getAgentScope } from "@/lib/agent-scope";
import { prisma } from "@/lib/prisma";
import { addYearsKeepingDay, alignToDebitDay, debitDayLabel } from "@/lib/sip-dates";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const FUND_BANK: Record<
  string,
  { name: string; accountNo: string; bankName: string; branch: string; routing: string }
> = {
  EFUF: { name: "EKUSH FIRST UNIT FUND", accountNo: "1513205101231001", bankName: "BRAC BANK LIMITED", branch: "R K MISSION ROAD", routing: "060272531" },
  EGF: { name: "EKUSH GROWTH FUND", accountNo: "1513205101212001", bankName: "BRAC BANK LIMITED", branch: "R K MISSION ROAD", routing: "060272531" },
  ESRF: { name: "EKUSH STABLE RETURN FUND", accountNo: "2055604070001", bankName: "BRAC BANK LIMITED", branch: "GRAPHICS BUILDING", routing: "060272531" },
};

type InvestorRow = {
  id: string;
  investorCode: string;
  name: string;
  jointApplicantName: string | null;
  signatureUrl: string | null;
};
type BankRow = {
  accountNumber: string;
  bankName: string;
  branchName: string | null;
  routingNumber: string | null;
};

/** Combined account-holder name for jointly-held accounts — same rule as the
 *  portal's lib/account-name.ts, so both forms print the same string. */
function accountHolderName(inv: { name: string; jointApplicantName?: string | null }): string {
  const joint = inv.jointApplicantName?.trim();
  return joint ? `${inv.name} & ${joint}` : inv.name;
}

const fmtDate = (d: Date) =>
  `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;

export default async function AgentDdiFormPage({
  searchParams,
}: {
  searchParams: {
    sipPlanId?: string;
    investorCode?: string;
    fundCode?: string;
    amount?: string;
    debitDay?: string;
    tenure?: string;
  };
}) {
  const scope = await getAgentScope();
  if (!scope.agentId) redirect("/agent/login");

  let investor: InvestorRow | null = null;
  let bank: BankRow | null = null;
  let fundCode = "EFUF";
  let amount = 0;
  let debitDay = 5;
  let tenure = 5;
  let applicationDate = new Date();
  let savedStart: Date | null = null;
  let savedEnd: Date | null = null;

  if (searchParams.sipPlanId) {
    const rows = await prisma.$queryRawUnsafe<
      Array<{
        investorId: string; investorCode: string; name: string; jointApplicantName: string | null;
        signatureUrl: string | null; fundCode: string; amount: unknown; debitDay: number;
        startDate: Date; endDate: Date | null; createdAt: Date;
        accountNumber: string | null; bankName: string | null; branchName: string | null; routingNumber: string | null;
      }>
    >(
      `SELECT i.id AS "investorId", i."investorCode", i.name, i."jointApplicantName", i."signatureUrl",
              f.code AS "fundCode", s.amount, s."debitDay", s."startDate", s."endDate", s."createdAt",
              b."accountNumber", b."bankName", b."branchName", b."routingNumber"
         FROM public.sip_plans s
         JOIN public.investors i ON i.id = s."investorId"
         JOIN public.funds f ON f.id = s."fundId"
         LEFT JOIN public.bank_accounts b ON b.id = s."bankAccountId"
        WHERE s.id = $1
        LIMIT 1`,
      searchParams.sipPlanId,
    );
    const r = rows[0];
    if (!r) return <Missing>SIP plan not found.</Missing>;
    // The agent may only open a plan belonging to an investor they sourced.
    if (!scope.codeSet.has(r.investorCode)) redirect("/agent/sip");

    investor = {
      id: r.investorId, investorCode: r.investorCode, name: r.name,
      jointApplicantName: r.jointApplicantName, signatureUrl: r.signatureUrl,
    };
    bank = r.accountNumber
      ? { accountNumber: r.accountNumber, bankName: r.bankName ?? "", branchName: r.branchName, routingNumber: r.routingNumber }
      : null;
    fundCode = r.fundCode;
    amount = Number(r.amount);
    debitDay = Number(r.debitDay);
    savedStart = r.startDate;
    savedEnd = r.endDate;
    applicationDate = r.createdAt;
    tenure = savedEnd ? savedEnd.getFullYear() - savedStart.getFullYear() : 5;
  } else {
    const code = String(searchParams.investorCode ?? "").trim();
    if (!scope.codeSet.has(code)) redirect("/agent/sip");
    const rows = await prisma.$queryRawUnsafe<
      Array<InvestorRow & { accountNumber: string | null; bankName: string | null; branchName: string | null; routingNumber: string | null }>
    >(
      `SELECT i.id, i."investorCode", i.name, i."jointApplicantName", i."signatureUrl",
              b."accountNumber", b."bankName", b."branchName", b."routingNumber"
         FROM public.investors i
         LEFT JOIN LATERAL (
           SELECT * FROM public.bank_accounts ba
            WHERE ba."investorId" = i.id AND ba.status = 'ACTIVE'
            ORDER BY ba."isPrimary" DESC, ba."createdAt" ASC LIMIT 1
         ) b ON true
        WHERE i."investorCode" = $1
        LIMIT 1`,
      code,
    );
    const r = rows[0];
    if (!r) return <Missing>Investor not found.</Missing>;
    investor = { id: r.id, investorCode: r.investorCode, name: r.name, jointApplicantName: r.jointApplicantName, signatureUrl: r.signatureUrl };
    bank = r.accountNumber
      ? { accountNumber: r.accountNumber, bankName: r.bankName ?? "", branchName: r.branchName, routingNumber: r.routingNumber }
      : null;
    fundCode = String(searchParams.fundCode ?? "EFUF").toUpperCase();
    amount = Number(searchParams.amount ?? 0);
    debitDay = Number(searchParams.debitDay ?? 5);
    tenure = Number(searchParams.tenure ?? 5);
  }

  const fundBank = FUND_BANK[fundCode] ?? FUND_BANK.EFUF;
  const startDate = alignToDebitDay(savedStart ?? applicationDate, debitDay);
  const endDate = savedEnd ?? addYearsKeepingDay(startDate, tenure, debitDay);
  const dateDigits = fmtDate(applicationDate).replace(/\//g, "").split("");

  // The investor's stored signature lives in the same private bucket the
  // portal reads; sign it for the render so the printed form carries it.
  let signatureUrl: string | null = null;
  if (investor.signatureUrl) {
    try {
      const supa = createSupabaseAdminClient();
      // Returns null when the service-role env vars are unset. A missing
      // signature is not a reason to fail the form — it falls back to the
      // ruled blank line the investor signs by hand.
      const { data } = supa
        ? await supa.storage.from("kyc-documents").createSignedUrl(investor.signatureUrl, 300)
        : { data: null };
      signatureUrl = data?.signedUrl ?? null;
    } catch {
      signatureUrl = null;
    }
  }

  const S: Record<string, React.CSSProperties> = {
    page: { width: "210mm", minHeight: "297mm", padding: "20mm 18mm", margin: "0 auto", background: "#fff", fontFamily: "Arial, Helvetica, sans-serif", fontSize: "10pt", color: "#000", lineHeight: "1.4" },
    formTitle: { fontSize: "18pt", fontWeight: 700, textAlign: "center", textTransform: "uppercase", letterSpacing: "3px", borderBottom: "1px solid #000", paddingBottom: "3mm", marginBottom: "8mm" },
    sectionHeader: { fontSize: "12pt", fontWeight: 700, textTransform: "uppercase", marginBottom: "3mm", marginTop: "6mm" },
    table: { width: "100%", borderCollapse: "collapse", marginBottom: "4mm" },
    tdLabel: { border: "1px solid #000", padding: "6px 8px", fontWeight: 700, fontSize: "10pt", width: "45%", background: "#fafafa" },
    tdValue: { border: "1px solid #000", padding: "6px 8px", fontSize: "10pt" },
    para: { fontSize: "10pt", textAlign: "justify", lineHeight: "1.5", marginBottom: "4mm" },
    sigRow: { display: "flex", justifyContent: "space-between", marginTop: "20mm" },
    sigBox: { width: "45%", textAlign: "center" },
    sigLine: { borderTop: "1px solid #000", marginTop: "25mm", paddingTop: "2mm" },
  };

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: `
        @media print { body { margin:0; padding:0; -webkit-print-color-adjust:exact; print-color-adjust:exact; } .no-print { display:none!important; } .print-page { width:210mm; min-height:297mm; padding:20mm 18mm; margin:0; box-shadow:none!important; } }
        @page { size: A4 portrait; margin: 0; }
      `}} />

      <div className="no-print" style={{ position: "fixed", top: 16, right: 16, zIndex: 50, display: "flex", gap: 8 }}>
        <button id="print-btn" style={{ padding: "8px 16px", background: "#047857", color: "#fff", border: "none", borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: "pointer" }}>
          Save as PDF / Print
        </button>
        <a href="/agent/sip" style={{ padding: "8px 16px", background: "#fff", color: "#333", border: "1px solid #ddd", borderRadius: 6, fontSize: 14, textDecoration: "none" }}>Back</a>
      </div>
      <script dangerouslySetInnerHTML={{ __html: `document.getElementById('print-btn').addEventListener('click',function(){window.print()});` }} />

      <div className="print-page" style={S.page}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "10mm" }}>
          <div>
            <p style={{ fontSize: "14pt", fontWeight: 700, fontStyle: "italic", margin: "0 0 2mm 0" }}>Systematic Investment Plan</p>
            <p style={{ fontSize: "11pt", margin: "0 0 1mm 0" }}>Asset Manager: Ekush Wealth Management Limited</p>
            <p style={{ fontSize: "11pt", fontWeight: 700, margin: 0 }}>Mutual Fund: {fundBank.name}</p>
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="Ekush" style={{ height: "22mm", flexShrink: 0 }} />
        </div>

        <div style={S.formTitle}>AUTO DEBIT INSTRUCTION FORM</div>

        <div style={{ display: "flex", alignItems: "center", gap: "4mm", marginBottom: "8mm" }}>
          <span style={{ fontWeight: 700, fontSize: "10pt" }}>Date of Application</span>
          <div style={{ display: "flex", gap: "1mm" }}>
            {dateDigits.map((d, i) => (
              <div key={i} style={{ width: "8mm", height: "8mm", border: "1px solid #000", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "11pt", fontWeight: 700 }}>{d}</div>
            ))}
          </div>
        </div>

        <div style={S.sectionHeader}>INVESTOR&apos;S INFORMATION</div>
        <table style={S.table}>
          <tbody>
            <tr>
              <td style={{ ...S.tdLabel, width: "25%" }}>Name of the Investor</td>
              <td style={S.tdValue}>{accountHolderName(investor)}</td>
              <td style={{ ...S.tdLabel, width: "18%" }}>Investor Code</td>
              <td style={{ ...S.tdValue, width: "15%" }}>{investor.investorCode}</td>
            </tr>
          </tbody>
        </table>

        <div style={S.sectionHeader}>DIRECT DEBIT INSTRUCTION (DDI) INFORMATION</div>
        <table style={S.table}>
          <tbody>
            <tr><td style={S.tdLabel}>DDI START DATE</td><td style={S.tdValue}>{fmtDate(startDate)}</td></tr>
            <tr><td style={S.tdLabel}>DDI END DATE</td><td style={S.tdValue}>{fmtDate(endDate)}</td></tr>
            <tr><td style={S.tdLabel}>SIP TENURE</td><td style={S.tdValue}>{String(tenure).padStart(2, "0")} years</td></tr>
            <tr><td style={S.tdLabel}>DDI PULL DATE OF THE MONTH</td><td style={S.tdValue}>{debitDayLabel(debitDay)}</td></tr>
            <tr><td style={S.tdLabel}>MONTHLY DDI AMOUNT (BDT)</td><td style={S.tdValue}>BDT {amount.toLocaleString("en-IN")}</td></tr>
          </tbody>
        </table>

        <table style={S.table}>
          <tbody>
            <tr><td style={S.tdLabel}>BANK ACCOUNT NAME</td><td style={S.tdValue}>{accountHolderName(investor)}</td></tr>
            <tr><td style={S.tdLabel}>BANK ACCOUNT NUMBER</td><td style={S.tdValue}>{bank?.accountNumber ?? ""}</td></tr>
            <tr><td style={S.tdLabel}>BANK NAME</td><td style={S.tdValue}>{bank?.bankName ?? ""}</td></tr>
            <tr><td style={S.tdLabel}>BRANCH NAME</td><td style={S.tdValue}>{bank?.branchName ?? ""}</td></tr>
            <tr><td style={S.tdLabel}>ROUTING NUMBER</td><td style={S.tdValue}>{bank?.routingNumber ?? ""}</td></tr>
          </tbody>
        </table>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: "6mm", marginBottom: "3mm" }}>
          <span style={{ fontSize: "12pt", fontWeight: 700, textTransform: "uppercase" }}>FUND&apos;S (COLLECTION) BANK DETAILS</span>
          <span style={{ fontSize: "9pt", color: "#666" }}>FILLED BY OFFICE</span>
        </div>
        <table style={S.table}>
          <tbody>
            <tr><td style={S.tdLabel}>BANK ACCOUNT NAME</td><td style={S.tdValue}>{fundBank.name}</td></tr>
            <tr><td style={S.tdLabel}>BANK ACCOUNT NUMBER</td><td style={S.tdValue}>{fundBank.accountNo}</td></tr>
            <tr><td style={S.tdLabel}>BANK NAME</td><td style={S.tdValue}>{fundBank.bankName}</td></tr>
            <tr><td style={S.tdLabel}>BRANCH NAME</td><td style={S.tdValue}>{fundBank.branch}</td></tr>
            <tr><td style={S.tdLabel}>ROUTING NUMBER</td><td style={S.tdValue}>{fundBank.routing}</td></tr>
          </tbody>
        </table>

        <div style={S.sectionHeader}>INVESTOR ACKNOWLEDGEMENT</div>
        <p style={S.para}>
          I/ We, maintaining an account with the above-mentioned bank, hereby would like to inform you that I/we have
          authorized {fundBank.name} to debit my/our account through online fund transfer processes by an
          amount not exceeding the above-mentioned amount. The auto debit instruction will be initiated by the designated
          Bank at the instruction of {fundBank.name} managed by Ekush Wealth Management Limited. The
          account shall be debited on a monthly basis and the instruction shall be valid from the debit start date to debit
          end date as mentioned above.
        </p>
        <p style={S.para}>
          I have read and understood the terms and conditions of payment through the Auto-debit payment process, which
          may be altered, modified, and replaced from time to time by Ekush Wealth Management Limited as per regulatory
          requirements.
        </p>

        <div style={{ ...S.sectionHeader, marginTop: "8mm" }}>SIGNATURES AS PER THE BANK ACCOUNT</div>
        <div style={S.sigRow}>
          <div style={S.sigBox}>
            {signatureUrl ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={signatureUrl} alt="Principal applicant signature" style={{ height: "20mm", maxWidth: "100%", objectFit: "contain", display: "block", margin: "0 auto" }} />
                <div style={{ borderTop: "1px solid #000", marginTop: "2mm", paddingTop: "2mm" }}>Principal Applicant</div>
              </>
            ) : (
              <div style={S.sigLine}>Principal Applicant</div>
            )}
          </div>
          <div style={S.sigBox}>
            {investor.jointApplicantName ? (
              <div style={{ ...S.sigLine, fontWeight: 700 }}>{investor.jointApplicantName}</div>
            ) : (
              <div style={S.sigLine}>Joint Applicant (If Any)</div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function Missing({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: 40, textAlign: "center", color: "#666" }}>{children}</div>;
}
