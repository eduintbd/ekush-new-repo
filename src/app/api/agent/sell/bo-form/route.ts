// GET /api/agent/sell/bo-form — the filled CDBL Form 14 ("BO Units Withdrawal"
// form) for one of the agent's investors. Port of the portal's
// /api/forms/bo-withdrawal, with the same two modes:
//
//   ?orderId=<id>                                  re-download an existing
//        order's form, dated with the order's placement date so it matches
//        what was first issued.
//   ?investorCode=BI0008&fundCode=EFUF&units=500   preview in the Sell Fund
//        wizard, before the order exists. Dated today.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAgentScope } from "@/lib/agent-scope";
import { listPurchaseInvestors } from "@/lib/agent-purchase";
import { getBoWithdrawalData } from "@/lib/bo-withdrawal";
import { boWithdrawalFileName, renderBoWithdrawalForm } from "@/lib/bo-withdrawal-pdf";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: Request): Promise<NextResponse> {
  const scope = await getAgentScope();
  if (!scope.agentId) {
    return NextResponse.json({ error: "Not linked to an agent record." }, { status: 403 });
  }
  const allowed = await listPurchaseInvestors({ agentCode: scope.agentCode, linkedCodes: scope.codes });

  const q = new URL(req.url).searchParams;
  const orderId = (q.get("orderId") || "").trim();

  let investorId: string;
  let fundCode: string;
  let units: number;
  let orderDate: Date;

  if (orderId) {
    const r = (
      await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT o."investorId", i."investorCode", f.code AS "fundCode", o."createdAt",
                COALESCE(b.units, o.units, o."estUnits") AS units
           FROM public.orders o
           JOIN public.bo_withdrawal_requests b ON b."orderId" = o.id
           JOIN public.investors i ON i.id = o."investorId"
           JOIN public.funds f ON f.id = o."fundId"
          WHERE o.id = $1 LIMIT 1`,
        orderId,
      )
    )[0];
    if (!r) return NextResponse.json({ error: "Withdrawal request not found" }, { status: 404 });
    if (!allowed.some((a) => a.investorCode === r.investorCode)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    investorId = String(r.investorId);
    fundCode = String(r.fundCode);
    units = Number(r.units);
    orderDate = r.createdAt as Date;
  } else {
    const code = (q.get("investorCode") || "").trim();
    const inv = allowed.find((a) => a.investorCode === code);
    if (!inv) return NextResponse.json({ error: `${code} is not one of your investors.` }, { status: 403 });
    investorId = inv.investorId;
    fundCode = (q.get("fundCode") || "").toUpperCase();
    units = parseFloat(q.get("units") || "0");
    orderDate = new Date();
    if (!fundCode || !Number.isFinite(units) || units <= 0) {
      return NextResponse.json({ error: "Fund and positive units required" }, { status: 400 });
    }
  }

  const result = await getBoWithdrawalData({ investorId, fundCode, units, orderDate });
  if (!result.ok) {
    return NextResponse.json(
      { error: result.message, reason: result.reason },
      { status: result.reason === "NOT_FOUND" ? 404 : 400 },
    );
  }

  const pdf = await renderBoWithdrawalForm(result.data);

  // Same stamp the portal sets, so /admin/bo-withdrawals shows the form was pulled.
  if (orderId) {
    await prisma
      .$executeRawUnsafe(
        `UPDATE public.bo_withdrawal_requests SET "formGeneratedAt" = now()
          WHERE "orderId" = $1 AND "formGeneratedAt" IS NULL`,
        orderId,
      )
      .catch(() => {});
  }

  return new NextResponse(pdf as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${boWithdrawalFileName(result.data)}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
