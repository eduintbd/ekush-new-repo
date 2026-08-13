// GET /api/agent/sip/[id]/bank-excel
// The bank auto-debit mandate spreadsheet for one agent-created SIP — the same
// file the portal admin downloads from the approvals card, in the same format
// the collection bank expects.
//
// Agent-scoped: the plan's investor must be one this agent sourced. Note the
// portal's equivalent route gates only on "is staff" and does no investor
// scoping at all, so any staff member can pull any investor's mandate; that is
// acceptable for back-office users and is not acceptable here.
//
// The file is downloadable before approval, matching the portal. The mandate is
// only real once the office approves the plan and sends it on — the download
// exists so the agent can check the figures with the investor while the DDI
// form is being signed.

import { NextResponse } from "next/server";
import { getAgentScope } from "@/lib/agent-scope";
import { prisma } from "@/lib/prisma";
import { addYearsKeepingDay, alignToDebitDay, ordinal } from "@/lib/sip-dates";
import { bankAmount, bdMobile, buildBankDdiExcel, fmtDMY } from "@/lib/bank-ddi-excel";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
): Promise<NextResponse | Response> {
  const scope = await getAgentScope();
  if (!scope.agentId) return new Response("Not linked to an agent record.", { status: 403 });

  const rows = await prisma.$queryRawUnsafe<
    Array<{
      investorCode: string; name: string; jointApplicantName: string | null;
      email: string | null; phone: string | null; fundCode: string;
      amount: unknown; debitDay: number; startDate: Date; endDate: Date | null;
      accountNumber: string | null; routingNumber: string | null;
    }>
  >(
    `SELECT i."investorCode", i.name, i."jointApplicantName", u.email, u.phone,
            f.code AS "fundCode", s.amount, s."debitDay", s."startDate", s."endDate",
            COALESCE(b."accountNumber", fb."accountNumber") AS "accountNumber",
            COALESCE(b."routingNumber", fb."routingNumber") AS "routingNumber"
       FROM public.sip_plans s
       JOIN public.investors i ON i.id = s."investorId"
       JOIN public.funds f ON f.id = s."fundId"
       LEFT JOIN public.users u ON u.id = i."userId"
       LEFT JOIN public.bank_accounts b ON b.id = s."bankAccountId"
       LEFT JOIN LATERAL (
         SELECT * FROM public.bank_accounts ba
          WHERE ba."investorId" = i.id AND ba.status = 'ACTIVE'
          ORDER BY ba."isPrimary" DESC, ba."createdAt" ASC LIMIT 1
       ) fb ON true
      WHERE s.id = $1
      LIMIT 1`,
    params.id,
  );

  const r = rows[0];
  if (!r) return new Response("SIP plan not found.", { status: 404 });
  if (!scope.codeSet.has(r.investorCode)) {
    return new Response("That SIP does not belong to one of your investors.", { status: 403 });
  }

  const debitDay = Number(r.debitDay);
  const start = alignToDebitDay(r.startDate, debitDay);
  // Five-year fallback, as the portal's route does, for a plan saved without an
  // end date.
  const end = r.endDate ?? addYearsKeepingDay(start, 5, debitDay);
  const holder = (r.jointApplicantName?.trim() ? `${r.name} & ${r.jointApplicantName}` : r.name).toUpperCase();

  const buf = await buildBankDdiExcel({
    mandateReference: r.investorCode,
    debitAccountName: holder,
    debitAccountNumber: r.accountNumber ?? "",
    routingNumber: r.routingNumber ?? "",
    amount: bankAmount(Number(r.amount)),
    creditNarration: r.investorCode,
    cycleType: "Monthly",
    siStartDate: fmtDMY(start),
    siEndDate: fmtDMY(end),
    receiverEmail: r.email ?? "",
    receiverMobile: bdMobile(r.phone),
  });

  const today = new Date();
  const stamp = `${today.getFullYear()}.${String(today.getMonth() + 1).padStart(2, "0")}.${String(today.getDate()).padStart(2, "0")}`;
  const filename = `${ordinal(debitDay)}_${r.investorCode}_${r.fundCode} ${stamp}.xlsx`;

  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
