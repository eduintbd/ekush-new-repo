// CSV export of receivables aging — same FIFO settlement as the
// on-screen /receivables view, broken out one row per open item.

import { type NextRequest } from "next/server";
import { requireStaff } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { csvResponse, toCsv } from "@/lib/csv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  await requireStaff();
  const sp = req.nextUrl.searchParams;
  const accountName = sp.get("account") ?? "Management Fee Accrued";
  const asOf = sp.get("asOf") ? new Date(sp.get("asOf")!) : new Date();

  const lines = await prisma.journal.findMany({
    where: { accountName, entryDate: { lte: asOf } },
    orderBy: [{ entryDate: "asc" }, { createdAt: "asc" }],
    select: { id: true, entryDate: true, description: true, debit: true, credit: true, fundCode: true, voucherNo: true },
  });

  type Open = {
    id: string;
    entryDate: Date;
    description: string | null;
    fundCode: string | null;
    voucherNo: string | null;
    original: number;
    remaining: number;
  };
  const queue: Open[] = [];
  for (const l of lines) {
    const d = Number(l.debit);
    const c = Number(l.credit);
    if (d > 0) queue.push({ id: l.id, entryDate: l.entryDate, description: l.description, fundCode: l.fundCode, voucherNo: l.voucherNo, original: d, remaining: d });
    else if (c > 0) {
      let toSettle = c;
      for (const i of queue) {
        if (toSettle <= 0) break;
        if (i.remaining <= 0) continue;
        const apply = Math.min(i.remaining, toSettle);
        i.remaining -= apply;
        toSettle -= apply;
      }
    }
  }
  const open = queue.filter((i) => i.remaining > 0.005);

  const rows = open.map((i) => {
    const ageDays = Math.floor((asOf.getTime() - i.entryDate.getTime()) / 86400000);
    const bucket =
      ageDays <= 30 ? "0-30" : ageDays <= 60 ? "31-60" : ageDays <= 90 ? "61-90" : ageDays <= 180 ? "91-180" : "180+";
    return {
      Date: i.entryDate.toISOString().slice(0, 10),
      Voucher: i.voucherNo ?? "",
      Fund: i.fundCode ?? "",
      Description: i.description ?? "",
      "Original (Dr)": i.original,
      Outstanding: i.remaining,
      "Age (days)": ageDays,
      Bucket: bucket,
    };
  });
  return csvResponse(
    toCsv(rows),
    `receivables-${accountName.replace(/[^a-z0-9]+/gi, "_")}-asof-${asOf.toISOString().slice(0, 10)}.csv`,
  );
}
