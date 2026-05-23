// CSV export of a per-account ledger card.

import { type NextRequest } from "next/server";
import { requireStaff } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { csvResponse, toCsv } from "@/lib/csv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  await requireStaff();
  const { name } = await params;
  const accountName = decodeURIComponent(name);
  const sp = req.nextUrl.searchParams;
  const fyId = sp.get("fy");
  if (!fyId) return new Response("fy required", { status: 400 });

  const fy = await prisma.fiscalYear.findUnique({ where: { id: fyId } });
  if (!fy) return new Response("fy not found", { status: 404 });

  const fromDate = sp.get("from") ? new Date(sp.get("from")!) : null;
  const toDate = sp.get("to") ? new Date(sp.get("to")!) : null;
  const instrumentFilter = sp.get("instrument") || null;
  const openingCutoff = fromDate ?? fy.startsOn;

  const opening = await prisma.journal.aggregate({
    where: {
      accountName,
      entryDate: { lt: openingCutoff },
      ...(instrumentFilter ? { instrumentCode: instrumentFilter } : {}),
    },
    _sum: { debit: true, credit: true },
  });
  const openingBalance = Number(opening._sum.debit ?? 0) - Number(opening._sum.credit ?? 0);

  const lines = await prisma.journal.findMany({
    where: {
      accountName,
      fiscalYearId: fyId,
      ...(fromDate ? { entryDate: { gte: fromDate } } : {}),
      ...(toDate ? { entryDate: { lte: toDate } } : {}),
      ...(instrumentFilter ? { instrumentCode: instrumentFilter } : {}),
    },
    orderBy: [{ entryDate: "asc" }, { voucherNo: "asc" }, { createdAt: "asc" }],
    take: 5000,
  });

  let running = openingBalance;
  type Row = {
    Date: string;
    Voucher: string;
    Type: string;
    Description: string;
    Fund: string;
    Instrument: string;
    Debit: number | string;
    Credit: number | string;
    "Running balance": string;
  };
  const obDescr = instrumentFilter
    ? `Opening balance ${accountName} (${instrumentFilter})`
    : `Opening balance ${accountName}`;
  const rows: Row[] = [
    {
      Date: openingCutoff.toISOString().slice(0, 10),
      Voucher: "",
      Type: "OB",
      Description: obDescr,
      Fund: "",
      Instrument: instrumentFilter ?? "",
      Debit: "",
      Credit: "",
      "Running balance": drCr(running),
    },
  ];
  for (const j of lines) {
    const d = Number(j.debit);
    const c = Number(j.credit);
    running += d - c;
    rows.push({
      Date: j.entryDate.toISOString().slice(0, 10),
      Voucher: j.voucherNo ?? "",
      Type: j.txnType ?? "",
      Description: j.description ?? "",
      Fund: j.fundCode ?? "",
      Instrument: j.instrumentCode ?? "",
      Debit: d > 0 ? d : "",
      Credit: c > 0 ? c : "",
      "Running balance": drCr(running),
    });
  }
  const filenameSuffix = instrumentFilter ? `-${instrumentFilter}` : "";
  return csvResponse(
    toCsv(rows),
    `ledger-${accountName.replace(/[^a-z0-9]+/gi, "_")}${filenameSuffix}.csv`,
  );
}

function drCr(n: number): string {
  if (Math.abs(n) < 0.005) return "—";
  return `${Math.abs(n).toFixed(2)} ${n > 0 ? "Dr" : "Cr"}`;
}
