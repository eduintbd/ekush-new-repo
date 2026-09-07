// /agent/forms/order-confirmation — the receipt an agent hands the client
// straight after placing a purchase on their behalf.
//
// A faithful replica of the portal's (print)/forms/money-receipt page in its
// ORDER CONFIRMATION mode, which is the only mode that applies here: the agent
// prints this the moment the order is raised, long before the money reaches the
// fund's account and before the accountant has reconciled anything. The portal
// draws a hard line between the two documents, and the wording that line
// produces is reproduced verbatim — "Order received from", "for an intended
// investment of", "Est. Units", the orange this-is-not-a-money-receipt notice
// and the conditions clause. Getting that wrong is what made investors read a
// provisional slip as proof of a completed investment.
//
// The real MONEY RECEIPT stays where it is: the portal issues it against the
// settled transaction after reconciliation. Nothing here can produce one.
//
// Identity comes from investorCode in the query string, gated on the same
// investor set the purchase wizard offers, so an agent can only render their
// own clients' receipts.

import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getAgentScope } from "@/lib/agent-scope";
import { listPurchaseInvestors } from "@/lib/agent-purchase";
import { accountHolderName } from "@/lib/account-name";
import { getAuthorizedSignatureDataUrl, getLogoDataUrl } from "@/lib/print-assets";

export const dynamic = "force-dynamic";
export const metadata = { title: "Order confirmation — Agent portal" };

export default async function AgentOrderConfirmationPage({
  searchParams,
}: {
  searchParams: {
    investorCode?: string;
    fundCode?: string;
    fundName?: string;
    amount?: string;
    units?: string;
    nav?: string;
    orderId?: string;
  };
}) {
  const scope = await getAgentScope();
  if (!scope.agentId) redirect("/agent/login");

  const code = String(searchParams.investorCode ?? "").trim();
  const allowed = await listPurchaseInvestors({
    agentCode: scope.agentCode,
    linkedCodes: scope.codes,
  });
  if (!allowed.some((a) => a.investorCode === code)) redirect("/agent/purchase");

  const rows = await prisma.$queryRawUnsafe<
    Array<{ investorCode: string; name: string; jointApplicantName: string | null }>
  >(
    `SELECT "investorCode", name, "jointApplicantName"
       FROM public.investors WHERE "investorCode" = $1 LIMIT 1`,
    code,
  );
  const investor = rows[0];
  if (!investor) redirect("/agent/purchase");

  const authSignature = getAuthorizedSignatureDataUrl();
  const logo = getLogoDataUrl();

  const fundName = searchParams.fundName || "";
  const fundCode = searchParams.fundCode || "";
  const amountNum = parseFloat(searchParams.amount || "0");
  const unitsNum = parseFloat(searchParams.units || "0") || 0;
  const nav = parseFloat(searchParams.nav || "0");

  // Stable across reprints of the same order, and cannot collide across funds.
  // The portal's provisional branch uses a timestamp slice for the same reason;
  // anchoring ours to the order id makes a reprint reproduce the same number.
  const receiptNo = (searchParams.orderId ?? String(Date.now())).replace(/-/g, "").slice(-6).toUpperCase();

  const today = new Date();
  const dateStr = today.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  });

  const fmt = (n: number) =>
    n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtUnits = (n: number) =>
    n.toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 4 });

  const CELL_L: React.CSSProperties = {
    border: "1px solid #ccc",
    padding: "4px 10px",
    background: "#f9f9f9",
    fontWeight: 600,
    width: "30%",
  };
  const CELL_R: React.CSSProperties = { border: "1px solid #ccc", padding: "4px 10px" };

  return (
    <>
      <style
        dangerouslySetInnerHTML={{
          __html: `
        @media print {
          body{margin:0;padding:0;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
          .no-print{display:none!important;}
          .print-page{margin:0!important;box-shadow:none!important;}
        }
        @page{size:A4 landscape;margin:0;}
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
        className="print-page"
        style={{ width: "210mm", height: "148mm", boxSizing: "border-box", margin: "20px auto", background: "#fff", fontFamily: "Arial, Helvetica, sans-serif", fontSize: "11pt", color: "#000", position: "relative", border: "2px solid #F27023", borderRadius: "8px", overflow: "hidden" }}
      >
        {/* Header bar */}
        <div style={{ background: "linear-gradient(135deg, #F27023, #e85d04)", padding: "8px 20px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            {logo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logo} alt="Ekush" style={{ height: "46px" }} />
            ) : null}
          </div>
          <div style={{ textAlign: "right", color: "#fff" }}>
            <p style={{ fontSize: "15pt", fontWeight: 800, margin: 0, letterSpacing: "1px" }}>
              ORDER CONFIRMATION RECEIPT
            </p>
            <p style={{ fontSize: "8pt", margin: 0 }}>Ekush Wealth Management Limited</p>
          </div>
        </div>

        <div style={{ padding: "10px 24px 0 24px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px" }}>
            <div>
              <span style={{ fontSize: "10pt", color: "#666" }}>Receipt No: </span>
              <span style={{ fontSize: "12pt", fontWeight: 700 }}>{receiptNo}</span>
            </div>
            <div>
              <span style={{ fontSize: "10pt", color: "#666" }}>Date: </span>
              <span style={{ fontSize: "12pt", fontWeight: 700 }}>{dateStr}</span>
            </div>
          </div>

          <div style={{ fontSize: "11pt", lineHeight: "1.7", marginBottom: "6px" }}>
            <p style={{ margin: 0 }}>
              Order received from <strong>{accountHolderName(investor)}</strong> (
              {investor.investorCode})
            </p>
            <p style={{ margin: 0 }}>
              for an intended investment of <strong>BDT {fmt(amountNum)}</strong>
            </p>
            <p style={{ margin: "0 0 4px 0", fontSize: "10pt", color: "#666" }}>
              (In words: {numberToWords(amountNum)} Taka)
            </p>
          </div>

          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "10pt", marginBottom: "8px" }}>
            <tbody>
              <tr>
                <td style={CELL_L}>Fund</td>
                <td style={CELL_R}>
                  {fundName}
                  {fundCode ? ` (${fundCode})` : ""}
                </td>
              </tr>
              <tr>
                <td style={CELL_L}>Amount (BDT)</td>
                <td style={CELL_R}>{fmt(amountNum)}</td>
              </tr>
              <tr>
                <td style={CELL_L}>NAV per Unit</td>
                <td style={CELL_R}>{nav.toFixed(4)}</td>
              </tr>
              <tr>
                <td style={CELL_L}>Est. Units</td>
                <td style={CELL_R}>{fmtUnits(unitsNum)}</td>
              </tr>
              <tr>
                <td style={CELL_L}>Payment Method</td>
                <td style={CELL_R}>Bank Transfer</td>
              </tr>
              <tr>
                <td style={CELL_L}>Placed by</td>
                <td style={CELL_R}>Sales agent {scope.agentCode}, on the investor&apos;s instruction</td>
              </tr>
            </tbody>
          </table>

          <div style={{ marginTop: "8px", border: "1px solid #F27023", borderLeft: "3px solid #F27023", background: "#FFF4EC", padding: "7px 10px" }}>
            <p style={{ fontSize: "9pt", fontWeight: 700, color: "#B4551B", margin: "0 0 3px 0" }}>
              This is a confirmation of your order only
            </p>
            <p style={{ fontSize: "8.5pt", color: "#333", margin: 0, lineHeight: "1.45" }}>
              Your investment becomes effective only once the money is successfully deposited into
              the respective fund&apos;s bank account. The NAV and number of units shown above may
              therefore change accordingly. Please download your Money Receipt once we have
              confirmed your purchase.
            </p>
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "8px" }}>
            <div style={{ textAlign: "center", width: "40%" }}>
              <div style={{ height: "30px", marginTop: "14px", display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
                {authSignature ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={authSignature}
                    alt="Ekush Wealth Management authorized signature"
                    style={{ maxHeight: "30px", maxWidth: "100%", objectFit: "contain", display: "block" }}
                  />
                ) : null}
              </div>
              <div style={{ borderTop: "1px solid #000", paddingTop: "4px" }}>
                <span style={{ fontSize: "9pt", color: "#666" }}>Authorized Signature</span>
              </div>
            </div>
          </div>
        </div>

        <div style={{ position: "absolute", bottom: 0, left: 0, right: 0 }}>
          <div style={{ padding: "0 24px 6px 24px" }}>
            <p style={{ fontSize: "7.5pt", color: "#666", fontStyle: "italic", margin: 0, lineHeight: "1.4" }}>
              Conditions apply: this confirmation takes effect upon encashment of your payment. If
              any delay occurs due to unavoidable circumstances outside Ekush&apos;s control, this
              confirmation will become invalid. This is not a money receipt and is not proof of
              payment.
            </p>
          </div>
          <div style={{ background: "#F27023", color: "#fff", padding: "4px 20px", display: "flex", justifyContent: "space-between", fontSize: "7pt" }}>
            <span>+8801713-086101</span>
            <span>info@ekushwml.com</span>
            <span>www.ekushwml.com</span>
          </div>
        </div>
      </div>
    </>
  );
}

// Verbatim from the portal's receipt so the amount in words matches on both.
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
