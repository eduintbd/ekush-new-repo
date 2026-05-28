// CSV export of journal lines, honouring the same filters as /journals.

import { type NextRequest } from "next/server";
import type { Prisma } from "@/generated/prisma";
import { requireStaff } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { csvResponse, toCsv } from "@/lib/csv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  await requireStaff();
  const sp = req.nextUrl.searchParams;
  const fyId = sp.get("fy");
  if (!fyId) return new Response("fy required", { status: 400 });

  const where: Prisma.JournalWhereInput = {
    fiscalYearId: fyId,
    ...(sp.get("account") ? { accountName: { contains: sp.get("account")!, mode: "insensitive" } } : {}),
    ...(sp.get("txnType") ? { txnType: sp.get("txnType")! } : {}),
    ...(sp.get("q") ? { description: { contains: sp.get("q")!, mode: "insensitive" } } : {}),
    ...(sp.get("voucher") ? { voucherNo: { contains: sp.get("voucher")!, mode: "insensitive" } } : {}),
    ...(sp.get("from") || sp.get("to")
      ? {
          entryDate: {
            ...(sp.get("from") ? { gte: new Date(sp.get("from")!) } : {}),
            ...(sp.get("to") ? { lte: new Date(sp.get("to")!) } : {}),
          },
        }
      : {}),
  };

  const lines = await prisma.journal.findMany({
    where,
    orderBy: [{ entryDate: "asc" }, { voucherNo: "asc" }, { createdAt: "asc" }],
    take: 50000,
  });
  const rows = lines.map((j) => ({
    Date: j.entryDate.toISOString().slice(0, 10),
    Voucher: j.voucherNo ?? "",
    Type: j.txnType ?? "",
    Account: j.accountName,
    Description: j.description ?? "",
    Instrument: j.instrumentCode ?? "",
    Debit: Number(j.debit),
    Credit: Number(j.credit),
    Batch: j.batchId ?? "",
  }));
  return csvResponse(toCsv(rows), `journals-${fyId.slice(0, 8)}.csv`);
}
