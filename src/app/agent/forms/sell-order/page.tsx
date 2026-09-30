// /agent/forms/sell-order?orderId=… — the investor's Sell Order Form for a BO
// sell of one of the agent's investors.
//
// A faithful replica of the portal's (print)/forms/sell-order page: same title,
// same green boxes, same instruction rows, declaration and signature block, so
// the client signs the same paperwork whoever raised the sale. The portal's
// version authorises by the investor's session; this one by the agent's
// investor set (same list as Sell Fund) and reads by raw SQL.

import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getAgentScope } from "@/lib/agent-scope";
import { listPurchaseInvestors } from "@/lib/agent-purchase";
import { signedKycUrl } from "@/lib/kyc-files";
import { accountHolderName } from "@/lib/account-name";
import { numberToWordsBDT } from "@/lib/number-to-words";
import { getLogoDataUrl } from "@/lib/print-assets";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sell order form — Agent portal" };

export default async function AgentSellOrderFormPage({
  searchParams,
}: {
  searchParams: { orderId?: string };
}) {
  const scope = await getAgentScope();
  if (!scope.agentId) redirect("/agent/login");

  const orderId = (searchParams.orderId || "").trim();
  if (!orderId) return <Message text="Missing order id." />;

  const r = (
    await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT o.direction, o."estNav", o."estAmount", o."createdAt", o.units AS "orderUnits", o."estUnits",
              f.name AS "fundName", f.code AS "fundCode",
              i.id AS "investorId", i."investorCode", i.name, i."jointApplicantName", i."signatureUrl",
              b.units AS "boUnits", b."boId", b."dpName", b."dpId",
              ba."bankName", ba."branchName", ba."accountNumber", ba."routingNumber"
         FROM public.orders o
         JOIN public.funds f ON f.id = o."fundId"
         JOIN public.investors i ON i.id = o."investorId"
         LEFT JOIN public.bo_withdrawal_requests b ON b."orderId" = o.id
         LEFT JOIN public.bank_accounts ba ON ba."investorId" = i.id AND ba."isPrimary" = true
        WHERE o.id = $1
        LIMIT 1`,
      orderId,
    )
  )[0];
  if (!r) return <Message text="Sell order not found." />;

  const allowed = await listPurchaseInvestors({ agentCode: scope.agentCode, linkedCodes: scope.codes });
  if (!allowed.some((a) => a.investorCode === r.investorCode)) redirect("/agent/sell");

  if (r.direction !== "SELL") return <Message text="This order is not a sell order." />;
  if (!r.boId) {
    return <Message text="This sell order has no BO/demat withdrawal record, so no sell order form is issued for it." />;
  }

  // Shapes the portal page renders from, so the markup below is unchanged.
  const order = {
    fund: { name: String(r.fundName), code: String(r.fundCode) },
    boWithdrawal: { boId: String(r.boId), dpName: String(r.dpName), dpId: String(r.dpId) },
  };
  const investor = {
    investorCode: String(r.investorCode),
    name: String(r.name ?? ""),
    jointApplicantName: (r.jointApplicantName as string | null) ?? null,
  };

  const sigDoc = await prisma.$queryRawUnsafe<Array<{ filePath: string }>>(
    `SELECT "filePath" FROM public.documents
      WHERE "investorId" = $1 AND type = 'SIGNATURE'
      ORDER BY "createdAt" DESC LIMIT 1`,
    String(r.investorId),
  );
  const signatureUrl = await signedKycUrl((r.signatureUrl as string | null) ?? sigDoc[0]?.filePath ?? null);
  const logo = getLogoDataUrl();

  const unitsNum = Math.abs(Number(r.boUnits ?? r.orderUnits ?? r.estUnits) || 0);
  const navNum = Math.abs(Number(r.estNav) || 0);
  const amountNum = Math.abs(Number(r.estAmount) || 0);

  const placed = r.createdAt as Date;
  const dd = String(placed.getDate()).padStart(2, "0");
  const mm = String(placed.getMonth() + 1).padStart(2, "0");
  const yyyy = String(placed.getFullYear());
  const dateDigits = (dd + mm + yyyy).split("");

  const bank = {
    bankName: (r.bankName as string | null) ?? "",
    branchName: (r.branchName as string | null) ?? "",
    accountNumber: (r.accountNumber as string | null) ?? "",
    routingNumber: (r.routingNumber as string | null) ?? "",
  };

  // ── Shared style tokens (identical to forms/purchase) ─────────
  const FONT = "Bahnschrift, 'Segoe UI', Calibri, sans-serif";
  const GREEN_BG = "#d8edbb";
  const GREEN_BORDER = "#b8d4a0";
  const BOX_H = "28px";

  const fmtUnits = (n: number) =>
    n.toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 4 });

  const field = (label: string, value: string, key: string) => (
    <div key={key} style={{ marginBottom: "4px" }}>
      <div style={{ fontFamily: FONT, fontSize: "11px", fontWeight: 600, color: "#000", marginBottom: "2px" }}>
        {label}
      </div>
      <div style={{ background: GREEN_BG, border: `1px solid ${GREEN_BORDER}`, height: BOX_H, display: "flex", alignItems: "center", padding: "0 10px" }}>
        <span style={{ fontFamily: FONT, fontSize: "12px", fontWeight: 700, color: "#000" }}>{value}</span>
      </div>
    </div>
  );

  const backHref = "/agent/sell";

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: `
        @media print {
          body{margin:0;padding:0;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
          .no-print{display:none!important;}
          .a4{box-shadow:none!important;}
        }
        @page{size:A4 portrait;margin:0;}
        *{box-sizing:border-box;}
      `}} />

      {/* Floating buttons (hidden on print) */}
      <div className="no-print" style={{position:"fixed",top:16,right:16,zIndex:50,display:"flex",gap:8}}>
        <button id="pb" style={{padding:"8px 16px",background:"#F27023",color:"#fff",border:"none",borderRadius:6,fontSize:13,fontWeight:600,cursor:"pointer"}}>
          Save as PDF / Print
        </button>
        <a href={backHref} style={{padding:"8px 16px",background:"#fff",color:"#333",border:"1px solid #ccc",borderRadius:6,fontSize:13,fontWeight:600,textDecoration:"none"}}>
          Back
        </a>
      </div>
      <script dangerouslySetInnerHTML={{__html:`document.getElementById('pb').onclick=function(){window.print()};`}} />

      {/* ═══ A4 PAGE ═══════════════════════════════════════════ */}
      <div className="a4" style={{
        width:"210mm", minHeight:"297mm", margin:"0 auto", background:"#fff",
        boxShadow:"0 4px 40px rgba(0,0,0,0.12)", padding:"15mm 20mm 12mm 20mm",
        fontFamily: FONT,
      }}>

        {/* ── HEADER ──────────────────────────────────────────── */}
        <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between"}}>
          <div style={{flex:1,paddingTop:"8px"}}>
            <h1 style={{
              fontFamily:FONT, fontSize:"18pt", fontWeight:700, color:"#000",
              margin:0, lineHeight:1.15,
            }}>
              INVESTOR&apos;S SELL ORDER FORM
            </h1>
            <p style={{
              fontFamily:FONT, fontSize:"11pt", fontWeight:400, color:"#000",
              margin:"5px 0 0 0", textDecoration:"underline", textTransform:"uppercase",
            }}>
              ASSET MANAGER: EKUSH WEALTH MANAGEMENT LIMITED
            </p>
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={logo ?? "/logo.png"} alt="Ekush" style={{height:"58px",marginTop:"-2px"}} />
        </div>

        <div style={{height:"18px"}} />

        {/* ── FUND NAME + DATE ────────────────────────────────── */}
        <div style={{display:"flex",gap:"14px",alignItems:"flex-end",marginBottom:"12px"}}>
          <div style={{flex:1}}>
            <div style={{fontFamily:FONT,fontSize:"11px",fontWeight:600,color:"#000",marginBottom:"2px"}}>
              Name of the Fund
            </div>
            <div style={{background:GREEN_BG,border:`1px solid ${GREEN_BORDER}`,height:BOX_H,display:"flex",alignItems:"center",padding:"0 10px"}}>
              <span style={{fontFamily:FONT,fontSize:"12px",fontWeight:700,color:"#000"}}>
                {order.fund.name} ({order.fund.code})
              </span>
            </div>
          </div>
          <div style={{display:"flex",alignItems:"flex-end",gap:"8px"}}>
            <span style={{fontFamily:FONT,fontSize:"11px",fontWeight:600,color:"#000",paddingBottom:"6px"}}>Date</span>
            <div style={{display:"flex",gap:"2px"}}>
              {dateDigits.map((d,i)=>(
                <div key={i} style={{
                  width:"22px",height:BOX_H,border:`1px solid ${GREEN_BORDER}`,background:GREEN_BG,
                  display:"flex",alignItems:"center",justifyContent:"center",
                  fontFamily:FONT,fontSize:"13px",fontWeight:700,color:"#000",
                }}>{d}</div>
              ))}
            </div>
          </div>
        </div>

        <div style={{height:"4px"}} />

        {/* ── INVESTOR IDENTITY ───────────────────────────────── */}
        {field("Investor Code", investor.investorCode, "code")}
        {field("Investor Name", accountHolderName(investor), "name")}

        {/* BO/DP snapshot taken when the order was placed — the same values the
            CDBL transfer request carries, so the two documents match. */}
        <div style={{display:"flex",gap:"10px",marginBottom:"18px"}}>
          <div style={{flex:1}}>{field("BO / Demat Account No.", order.boWithdrawal.boId, "bo")}</div>
          <div style={{flex:1}}>
            {field("Depository Participant (DP)", `${order.boWithdrawal.dpName} (${order.boWithdrawal.dpId})`, "dp")}
          </div>
        </div>

        {/* ── SELL INSTRUCTION ─────────────────────────────────── */}
        <div style={{textAlign:"center",marginBottom:"8px"}}>
          <span style={{fontFamily:FONT,fontSize:"11px",fontWeight:700,textDecoration:"underline",textTransform:"uppercase",letterSpacing:"0.5px"}}>
            Sale / Redemption Instruction
          </span>
        </div>

        {/* Units are the instruction; NAV and amount are submit-time snapshots
            (Order.estNav / Order.estAmount) and are labelled indicative so this
            is never read as a settlement statement. */}
        {[
          { label:"Number of Units to Sell", value:fmtUnits(unitsNum), words:"" },
          { label:"Indicative NAV per Unit (BDT)", value:navNum.toFixed(4), words:"" },
          { label:"Indicative Gross Proceeds (BDT)", value:amountNum.toLocaleString("en-IN",{minimumFractionDigits:2,maximumFractionDigits:2}), words:numberToWordsBDT(amountNum) },
        ].map((row,i)=>(
          <div key={i} style={{marginBottom:"6px"}}>
            <div style={{display:"flex",marginBottom:"2px"}}>
              <div style={{width:"45%",fontFamily:FONT,fontSize:"11px",fontWeight:700,color:"#000"}}>{row.label}</div>
              <div style={{width:"10%"}} />
              <div style={{width:"45%",fontFamily:FONT,fontSize:"11px",fontWeight:600,color:"#000",textAlign:"right"}}>
                {row.words ? "In Words" : ""}
              </div>
            </div>
            <div style={{display:"flex",border:`1px solid ${GREEN_BORDER}`,overflow:"hidden"}}>
              <div style={{width:"45%",background:GREEN_BG,height:BOX_H,display:"flex",alignItems:"center",padding:"0 10px"}}>
                <span style={{fontFamily:FONT,fontSize:"12px",fontWeight:700,color:"#000"}}>{row.value}</span>
              </div>
              <div style={{width:"1px",background:GREEN_BORDER}} />
              <div style={{flex:1,background:GREEN_BG,height:BOX_H,display:"flex",alignItems:"center",padding:"0 10px"}}>
                <span style={{fontFamily:FONT,fontSize:"11px",fontWeight:600,fontStyle:"italic",color:"#000"}}>{row.words}</span>
              </div>
            </div>
          </div>
        ))}

        <p style={{fontFamily:FONT,fontSize:"9.5px",color:"#555",fontStyle:"italic",margin:"6px 0 12px 0",lineHeight:1.45}}>
          The NAV and gross proceeds shown above are indicative, taken at the time this order was placed.
          Final proceeds are calculated at the NAV applicable on the actual date of sale, after deduction
          of any applicable charges and taxes.
        </p>

        {/* ── PROCEEDS BANK ACCOUNT ────────────────────────────── */}
        <div style={{textAlign:"center",marginBottom:"8px"}}>
          <span style={{fontFamily:FONT,fontSize:"11px",fontWeight:700,textDecoration:"underline"}}>
            Bank Account for Redemption Proceeds
          </span>
        </div>

        {[
          {label:"Bank Name",value:bank?.bankName||""},
          {label:"Branch Name",value:bank?.branchName||""},
          {label:"Account Number",value:bank?.accountNumber||""},
          {label:"Routing Number",value:bank?.routingNumber||""},
          {label:"Remarks (if any)",value:""},
        ].map((f,i)=>field(f.label, f.value, `bank-${i}`))}

        {/* ── DECLARATION ──────────────────────────────────────── */}
        <div style={{border:`1px solid ${GREEN_BORDER}`,background:"#fbfdf7",padding:"8px 10px",margin:"12px 0 0 0"}}>
          <p style={{fontFamily:FONT,fontSize:"9.5px",color:"#000",margin:0,lineHeight:1.5}}>
            I/We instruct Ekush Wealth Management Limited to redeem the number of units stated above from my/our
            holding in the fund named above, and to credit the net proceeds to the bank account stated above.
            I/We confirm that the units are free of any lien or encumbrance, and — where the units are held in a
            BO/demat account — that I/we have lodged the corresponding CDBL transfer request with my/our
            depository participant and will provide the DP-40 report evidencing the transfer.
          </p>
        </div>

        <div style={{height:"28px"}} />

        {/* ── SIGNATURES ───────────────────────────────────────── */}
        {/* Mirrors forms/purchase: the principal's stored signature is drawn ON
            the rule so the printed instruction reads as already signed; the
            fixed 22px strip above every line keeps all three rules level
            whether or not an image is present. */}
        <div style={{display:"flex",justifyContent:"space-between",padding:"0 2px"}}>
          {["Principal Signatory","Secondary Signatory","Additional Signatory (if any)"].map((lbl,i)=>(
            <div key={i} style={{width:"30%",textAlign:"center"}}>
              <div style={{height:"22px",display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
                {i === 0 && signatureUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={signatureUrl}
                    alt="Principal signatory signature"
                    style={{maxHeight:"22px",maxWidth:"100%",objectFit:"contain",display:"block"}}
                  />
                ) : null}
              </div>
              <div style={{borderTop:"1.5px solid #000",paddingTop:"4px"}}>
                <span style={{fontFamily:FONT,fontSize:"9px",color:"#777"}}>{lbl}</span>
              </div>
            </div>
          ))}
        </div>

        {/* ── VERIFIER BOX ─────────────────────────────────────── */}
        <div style={{border:"1px solid #000",marginTop:"14px"}}>
          <div style={{display:"flex"}}>
            <div style={{flex:1,padding:"6px 10px",borderRight:"1px solid #000"}}>
              <div style={{fontFamily:FONT,fontSize:"9px",color:"#777",marginBottom:"12px"}}>Verifier Name</div>
              <div style={{borderTop:"1px solid #ccc",paddingTop:"6px"}}>
                <span style={{fontFamily:FONT,fontSize:"9px",color:"#777"}}>Designation</span>
              </div>
            </div>
            <div style={{width:"100px",padding:"6px 10px"}}>
              <div style={{fontFamily:FONT,fontSize:"9px",color:"#777",textAlign:"right"}}>Signature</div>
            </div>
          </div>
        </div>

      </div>
    </>
  );
}

function Message({ text }: { text: string }) {
  return <div style={{ padding: 40, textAlign: "center", color: "#666" }}>{text}</div>;
}
