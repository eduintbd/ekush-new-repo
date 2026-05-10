// POST /api/exports/year-end?fiscalYearId=… → streaming .xlsx download.
// Restricted to staff (admin/accountant/auditor).

import { NextResponse, type NextRequest } from "next/server";
import { requireStaff } from "@/lib/auth";
import { buildYearEndWorkbook } from "@/lib/year-end-export";

export const runtime = "nodejs"; // exceljs needs Node, not edge
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  await requireStaff();
  const fiscalYearId = req.nextUrl.searchParams.get("fiscalYearId");
  if (!fiscalYearId) {
    return NextResponse.json({ error: "fiscalYearId required" }, { status: 400 });
  }

  try {
    const buf = await buildYearEndWorkbook(fiscalYearId);
    return new NextResponse(buf as unknown as BodyInit, {
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="year-end-${fiscalYearId}.xlsx"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "build failed" },
      { status: 500 },
    );
  }
}
