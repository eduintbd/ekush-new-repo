// GET /api/admin/agents/[id]/commissions/excel
// The multi-sheet workbook for one agent: Terms used / Transactions / Upfront
// watermark / Trail commissions / Payments / Summary. Admin, checker or
// accountant.

import { type NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { computeAgentCommissionPreview, parseAsOf } from "@/lib/agent-commission-preview";
import { listAgentPayments } from "@/lib/commission-payout";
import { buildAgentCommissionWorkbook } from "@/lib/agent-commission-workbook";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  // Accountant needs the workbook to check a period before posting it.
  await requireRole(["admin", "checker", "accountant"]);
  const { id } = await params;

  // ?asOf=YYYY-MM-DD mirrors the billing cut-off on /admin/agents/[id]. The
  // download link carries whatever the page is showing, so the workbook can
  // never disagree with the screen it was downloaded from. Absent → today.
  const asOf = parseAsOf(req.nextUrl.searchParams.get("asOf"));

  const [preview, payments] = await Promise.all([
    computeAgentCommissionPreview(prisma, id, asOf),
    listAgentPayments(id),
  ]);
  const buf = await buildAgentCommissionWorkbook(preview, { payments });
  const filename = `agent-commissions-${preview.agentCode}-${preview.asOf.toISOString().slice(0, 10)}.xlsx`;

  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
