// /agent/forms/purchase — the investor's purchase form, rendered for an agent
// placing an order on their client's behalf.
//
// A faithful replica of the portal's (print)/forms/purchase page: same title,
// same green field boxes, same allocation rows with amounts in words, same
// mode-of-transaction ticks, same signature block. The client receives the same
// paperwork whoever raised the order.
//
// The portal's version reads identity from the logged-in investor's own
// session. This one cannot — the agent is not the investor — so it takes
// investorCode in the query string and resolves identity, primary bank and
// stored signature by raw SQL, gated on the same investor set the purchase
// wizard offers. An agent can only ever render their own clients' forms.
//
// One deliberate difference: the portal draws Ekush's authorised signature in
// the verifier box from public/authorized-signature.png, which this repo does
// not carry. That cell prints blank here, exactly as the portal's own null
// fallback does.

import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getAgentScope } from "@/lib/agent-scope";
import { listPurchaseInvestors } from "@/lib/agent-purchase";
import { signedKycUrl } from "@/lib/kyc-files";
import { accountHolderName } from "@/lib/account-name";
import { getAuthorizedSignatureDataUrl, getLogoDataUrl } from "@/lib/print-assets";

export const dynamic = "force-dynamic";
export const metadata = { title: "Purchase form — Agent portal" };

type Row = {
  id: string;
  investorCode: string;
  name: string;
  jointApplicantName: string | null;
  signatureUrl: string | null;
  bankName: string | null;
  branchName: string | null;
  routingNumber: string | null;
};

export default async function AgentPurchaseFormPage({
  searchParams,
}: {
  searchParams: {
    investorCode?: string;
    fundCode?: string;
    fundName?: string;
    amount?: string;
    units?: string;
    nav?: string;
    payment?: string;
  };
}) {
  const scope = await getAgentScope();
  if (!scope.agentId) redirect("/agent/login");

  const code = String(searchParams.investorCode ?? "").trim();
  // Same permitted set as the wizard — wider than scope.codeSet, because an
  // investor this agent onboarded may not have a commission link yet.
  const allowed = await listPurchaseInvestors({
    agentCode: scope.agentCode,
    linkedCodes: scope.codes,
  });
  if (!allowed.some((a) => a.investorCode === code)) redirect("/agent/purchase");

  const rows = await prisma.$queryRawUnsafe<Row[]>(
    `SELECT i.id, i."investorCode", i.name, i."jointApplicantName", i."signatureUrl",
            b."bankName", b."branchName", b."routingNumber"
       FROM public.investors i
       LEFT JOIN public.bank_accounts b
              ON b."investorId" = i.id AND b."isPrimary" = true
      WHERE i."investorCode" = $1
      LIMIT 1`,
    code,
  );
  const investor = rows[0];
  if (!investor) redirect("/agent/purchase");

  // Client's signature: the in-portal signature pad writes investors.signatureUrl,
  // while a KYC upload stores it as a SIGNATURE document. Prefer the former.
  const sigDoc = await prisma.$queryRawUnsafe<Array<{ filePath: string }>>(
    `SELECT "filePath" FROM public.documents
      WHERE "investorId" = $1 AND type = 'SIGNATURE'
      ORDER BY "createdAt" DESC LIMIT 1`,
    investor.id,
  );
  const signatureUrl = await signedKycUrl(investor.signatureUrl ?? sigDoc[0]?.filePath ?? null);

  // Ekush's own mark for the verifier box — distinct from signatureUrl above,
  // which is the client's. Null → blank cell, as in the portal.
  const authSignature = getAuthorizedSignatureDataUrl();
  const logo = getLogoDataUrl();

  const fundName = searchParams.fundName || "";
  const amountNum = parseFloat(searchParams.amount || "0");
  const unitsNum = parseInt(searchParams.units || "0");
  const navNum = parseFloat(searchParams.nav || "0");
  const paymentMethod = searchParams.payment || "Bank Transfer";

  const today = new Date();
  const dateDigits = (
    String(today.getDate()).padStart(2, "0") +
    String(today.getMonth() + 1).padStart(2, "0") +
    String(today.getFullYear())
  ).split("");

  const isOnline = /transfer|online/i.test(paymentMethod);
  const isCheque = /cheque|pay.?order/i.test(paymentMethod);
  const isCash = /cash/i.test(paymentMethod);

  const FONT = "Bahnschrift, 'Segoe UI', Calibri, sans-serif";
  const VALUE_COLOR = "#355900";
  const GREEN_BG = "#d8edbb";
  const GREEN_BORDER = "#b8d4a0";
  const BOX_H = "28px";

  const holder = accountHolderName(investor);

  return (
    <>
      <style
        dangerouslySetInnerHTML={{
          __html: `
        @media print {
          body{margin:0;padding:0;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
          .no-print{display:none!important;}
          .a4{box-shadow:none!important;}
        }
        @page{size:A4 portrait;margin:0;}
        *{box-sizing:border-box;}
      `,
        }}
      />

      <div
        className="no-print"
        style={{ position: "fixed", top: 16, right: 16, zIndex: 50, display: "flex", gap: 8 }}
      >
        <button
          id="pb"
          style={{ padding: "8px 16px", background: "#F27023", color: "#fff", border: "none", borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: "pointer" }}
        >
          Save as PDF / Print
        </button>
        <a
          href="/agent/purchase"
          style={{ padding: "8px 16px", background: "#fff", color: "#333", border: "1px solid #ccc", borderRadius: 6, fontSize: 13, fontWeight: 600, textDecoration: "none" }}
        >
          Back
        </a>
      </div>
      <script
        dangerouslySetInnerHTML={{ __html: `document.getElementById('pb').onclick=function(){window.print()};` }}
      />

      <div
        className="a4"
        style={{
          width: "210mm",
          minHeight: "297mm",
          margin: "0 auto",
          background: "#fff",
          boxShadow: "0 4px 40px rgba(0,0,0,0.12)",
          padding: "15mm 20mm 12mm 20mm",
          fontFamily: FONT,
        }}
      >
        {/* ── HEADER ── */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
          <div style={{ flex: 1, paddingTop: "8px" }}>
            <h1 style={{ fontFamily: FONT, fontSize: "18pt", fontWeight: 700, color: "#000", margin: 0, lineHeight: 1.15 }}>
              INVESTOR&apos;S PURCHASE FORM
            </h1>
            <p style={{ fontFamily: FONT, fontSize: "11pt", fontWeight: 400, color: "#000", margin: "5px 0 0 0", textDecoration: "underline", textTransform: "uppercase" }}>
              ASSET MANAGER: EKUSH WEALTH MANAGEMENT LIMITED
            </p>
          </div>
          {logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logo} alt="Ekush" style={{ height: "58px", marginTop: "-2px" }} />
          ) : null}
        </div>

        <div style={{ height: "18px" }} />

        {/* ── FUND NAME + DATE ── */}
        <div style={{ display: "flex", gap: "14px", alignItems: "flex-end", marginBottom: "12px" }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: FONT, fontSize: "11px", fontWeight: 600, color: "#000", marginBottom: "2px" }}>
              Name of the Fund
            </div>
            <div style={{ background: GREEN_BG, border: `1px solid ${GREEN_BORDER}`, height: BOX_H, display: "flex", alignItems: "center", padding: "0 10px" }}>
              <span style={{ fontFamily: FONT, fontSize: "12px", fontWeight: 700, color: "#000" }}>{fundName}</span>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "flex-end", gap: "8px" }}>
            <span style={{ fontFamily: FONT, fontSize: "11px", fontWeight: 600, color: "#000", paddingBottom: "6px" }}>Date</span>
            <div style={{ display: "flex", gap: "2px" }}>
              {dateDigits.map((d, i) => (
                <div
                  key={i}
                  style={{ width: "22px", height: BOX_H, border: `1px solid ${GREEN_BORDER}`, background: GREEN_BG, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT, fontSize: "13px", fontWeight: 700, color: "#000" }}
                >
                  {d}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div style={{ height: "4px" }} />

        <LabeledBox label="Investor Code" value={investor.investorCode} font={FONT} bg={GREEN_BG} border={GREEN_BORDER} h={BOX_H} mb="6px" />
        <LabeledBox label="Investor Name" value={holder} font={FONT} bg={GREEN_BG} border={GREEN_BORDER} h={BOX_H} mb="18px" />

        {/* ── CONFIRMATION OF UNIT ALLOCATION ── */}
        <div style={{ textAlign: "center", marginBottom: "8px" }}>
          <span style={{ fontFamily: FONT, fontSize: "11px", fontWeight: 700, textDecoration: "underline", textTransform: "uppercase", letterSpacing: "0.5px" }}>
            Confirmation of Unit Allocation
          </span>
        </div>

        {[
          { label: "Investment Amount", value: amountNum.toLocaleString("en-IN", { maximumFractionDigits: 2 }), words: numberToWords(amountNum) },
          { label: "Cost Price Per Unit", value: navNum.toFixed(4), words: numberToWords(Math.round(navNum)) + " (per unit)" },
          { label: "Number of Allotted Units", value: unitsNum.toLocaleString("en-IN"), words: numberToWords(unitsNum) },
        ].map((row, i) => (
          <div key={i} style={{ marginBottom: "6px" }}>
            <div style={{ display: "flex", marginBottom: "2px" }}>
              <div style={{ width: "45%", fontFamily: FONT, fontSize: "11px", fontWeight: 700, color: "#000" }}>{row.label}</div>
              <div style={{ width: "10%" }} />
              <div style={{ width: "45%", fontFamily: FONT, fontSize: "11px", fontWeight: 600, color: "#000", textAlign: "right" }}>In Words</div>
            </div>
            <div style={{ display: "flex", border: `1px solid ${GREEN_BORDER}`, overflow: "hidden" }}>
              <div style={{ width: "45%", background: GREEN_BG, height: BOX_H, display: "flex", alignItems: "center", padding: "0 10px" }}>
                <span style={{ fontFamily: FONT, fontSize: "12px", fontWeight: 700, color: "#000" }}>{row.value}</span>
              </div>
              <div style={{ width: "1px", background: GREEN_BORDER }} />
              <div style={{ flex: 1, background: GREEN_BG, height: BOX_H, display: "flex", alignItems: "center", padding: "0 10px" }}>
                <span style={{ fontFamily: FONT, fontSize: "11px", fontWeight: 600, fontStyle: "italic", color: "#000" }}>{row.words}</span>
              </div>
            </div>
          </div>
        ))}

        <div style={{ height: "6px" }} />

        {/* ── MODE OF TRANSACTION ── */}
        <div style={{ textAlign: "center", marginBottom: "8px" }}>
          <span style={{ fontFamily: FONT, fontSize: "11px", fontWeight: 700, textDecoration: "underline" }}>Mode of Transaction</span>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", padding: "0 16px", marginBottom: "12px" }}>
          {[
            { label: "Online Transfer", checked: isOnline },
            { label: "Cheque/Pay Order", checked: isCheque },
            { label: "Cash", checked: isCash },
          ].map((item, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <div
                style={{ width: "14px", height: "14px", border: "1.5px solid #999", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "11px", fontWeight: 700, color: item.checked ? VALUE_COLOR : "transparent", background: item.checked ? GREEN_BG : "#fff" }}
              >
                X
              </div>
              <span style={{ fontFamily: FONT, fontSize: "11px" }}>{item.label}</span>
            </div>
          ))}
        </div>

        {/* ── BANK FIELDS ── */}
        {[
          { label: "Bank Name", value: investor.bankName || "" },
          { label: "Branch Name", value: investor.branchName || "" },
          { label: "Routing Number", value: investor.routingNumber || "" },
          { label: "Cheque Number/Pay Order Number (if any)", value: "" },
          { label: "Remarks (if any)", value: "" },
        ].map((f, i) => (
          <LabeledBox key={i} label={f.label} value={f.value} font={FONT} bg={GREEN_BG} border={GREEN_BORDER} h={BOX_H} mb="4px" />
        ))}

        <div style={{ height: "32px" }} />

        {/* ── SIGNATURES ── */}
        <div style={{ display: "flex", justifyContent: "space-between", padding: "0 2px" }}>
          {["Principal Signatory", "Secondary Signatory", "Additional Signatory (if any)"].map((lbl, i) => (
            <div key={i} style={{ width: "30%", textAlign: "center" }}>
              <div style={{ height: "22px", display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
                {i === 0 && signatureUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={signatureUrl} alt="Principal signatory signature" style={{ maxHeight: "22px", maxWidth: "100%", objectFit: "contain", display: "block" }} />
                ) : null}
              </div>
              <div style={{ borderTop: "1.5px solid #000", paddingTop: "4px" }}>
                <span style={{ fontFamily: FONT, fontSize: "9px", color: "#777" }}>{lbl}</span>
              </div>
            </div>
          ))}
        </div>

        {/* ── VERIFIER BOX ── */}
        <div style={{ border: "1px solid #000", marginTop: "14px" }}>
          <div style={{ display: "flex" }}>
            <div style={{ flex: 1, padding: "6px 10px", borderRight: "1px solid #000" }}>
              <div style={{ fontFamily: FONT, fontSize: "9px", color: "#777", marginBottom: "12px" }}>Verifier Name</div>
              <div style={{ borderTop: "1px solid #ccc", paddingTop: "6px" }}>
                <span style={{ fontFamily: FONT, fontSize: "9px", color: "#777" }}>Designation</span>
              </div>
            </div>
            <div style={{ width: "100px", padding: "6px 10px" }}>
              <div style={{ fontFamily: FONT, fontSize: "9px", color: "#777", textAlign: "right" }}>Signature</div>
              {authSignature ? (
                <div style={{ height: "26px", display: "flex", alignItems: "flex-end", justifyContent: "flex-end", marginTop: "2px" }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={authSignature}
                    alt="Ekush Wealth Management authorized signature"
                    style={{ maxHeight: "26px", maxWidth: "100%", objectFit: "contain", display: "block" }}
                  />
                </div>
              ) : null}
            </div>
          </div>
        </div>

        {/* Provenance line — this form was raised by an agent, not the investor.
            Small and at the foot so it does not disturb the portal's layout. */}
        <p style={{ fontFamily: FONT, fontSize: "8px", color: "#999", marginTop: "10px", textAlign: "right" }}>
          Raised by sales agent {scope.agentCode} on the investor&apos;s written instruction.
        </p>
      </div>
    </>
  );
}

function LabeledBox({
  label, value, font, bg, border, h, mb,
}: {
  label: string; value: string; font: string; bg: string; border: string; h: string; mb: string;
}) {
  return (
    <div style={{ marginBottom: mb }}>
      <div style={{ fontFamily: font, fontSize: "11px", fontWeight: 600, color: "#000", marginBottom: "2px" }}>{label}</div>
      <div style={{ background: bg, border: `1px solid ${border}`, height: h, display: "flex", alignItems: "center", padding: "0 10px" }}>
        <span style={{ fontFamily: font, fontSize: "12px", fontWeight: 700, color: "#000" }}>{value}</span>
      </div>
    </div>
  );
}

// Verbatim from the portal's form so the words on the two documents match
// digit for digit — including its Indian-system Thousand/Lakh/Crore grouping.
function numberToWords(n: number): string {
  if (n === 0) return "Zero";
  const ones = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
    "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
  const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
  const intPart = Math.floor(Math.abs(n));
  if (intPart === 0) return "Zero";
  let remaining = intPart;
  const groups: number[] = [];
  groups.push(remaining % 1000);
  remaining = Math.floor(remaining / 1000);
  while (remaining > 0) { groups.push(remaining % 100); remaining = Math.floor(remaining / 100); }
  const scales = ["", "Thousand", "Lakh", "Crore"];
  const parts: string[] = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i];
    if (g === 0) continue;
    let part = "";
    if (g >= 100) {
      part += ones[Math.floor(g / 100)] + " Hundred ";
      const rem = g % 100;
      if (rem >= 20) { part += tens[Math.floor(rem / 10)] + " " + ones[rem % 10]; }
      else if (rem > 0) { part += ones[rem]; }
    } else if (g >= 20) { part += tens[Math.floor(g / 10)] + " " + ones[g % 10]; }
    else { part += ones[g]; }
    parts.push(part.trim() + (scales[i] ? " " + scales[i] : ""));
  }
  return parts.join(" ").replace(/\s+/g, " ").trim() + " Only";
}
