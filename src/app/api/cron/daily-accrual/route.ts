// GET / POST /api/cron/daily-accrual
// Snapshots each approved agent's accrual state for today into the
// `CommissionAccrual` table — backs the agent dashboard's
// "accrued this quarter to date" tile. Idempotent: upserts on
// (agentId, snapshotDate).
//
// Auth: shared-secret. Accepts either:
//   - Vercel Cron: Authorization: Bearer $CRON_SECRET
//   - Manual / external scheduler: x-cron-secret: $CRON_SECRET
//
// Schedule: daily 02:00 UTC via vercel.json crons.

import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { authoriseCron, calendarQuarter, todayUtc } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function handle(req: NextRequest) {
  if (!authoriseCron(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const snapshotDate = todayUtc();
  const quarter = calendarQuarter(snapshotDate);

  const agents = await prisma.sellingAgent.findMany({
    where: { status: "approved" },
    select: { id: true, code: true },
  });

  // Date window for "today" — UTC day.
  const dayStart = snapshotDate;
  const dayEnd = new Date(dayStart);
  dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

  let snapshotted = 0;
  for (const agent of agents) {
    const [upfrontToday, trailToday, quarterToDate] = await Promise.all([
      prisma.commissionRun.aggregate({
        where: {
          agentId: agent.id,
          type: "upfront",
          createdAt: { gte: dayStart, lt: dayEnd },
        },
        _sum: { amount: true },
      }),
      prisma.commissionRun.aggregate({
        where: {
          agentId: agent.id,
          type: "trail",
          createdAt: { gte: dayStart, lt: dayEnd },
        },
        _sum: { amount: true },
      }),
      prisma.commissionRun.aggregate({
        where: {
          agentId: agent.id,
          periodEnd: { gte: quarter.start, lt: quarter.end },
          status: { in: ["accrued", "approved", "paid"] },
        },
        _sum: { amount: true },
      }),
    ]);

    await prisma.commissionAccrual.upsert({
      where: { agentId_snapshotDate: { agentId: agent.id, snapshotDate } },
      create: {
        agentId: agent.id,
        snapshotDate,
        upfrontTodayBdt: Number(upfrontToday._sum.amount ?? 0),
        trailTodayBdt: Number(trailToday._sum.amount ?? 0),
        quarterToDateBdt: Number(quarterToDate._sum.amount ?? 0),
      },
      update: {
        upfrontTodayBdt: Number(upfrontToday._sum.amount ?? 0),
        trailTodayBdt: Number(trailToday._sum.amount ?? 0),
        quarterToDateBdt: Number(quarterToDate._sum.amount ?? 0),
      },
    });
    snapshotted++;
  }

  console.log(
    JSON.stringify({
      event: "accrual.snapshot",
      snapshotDate: snapshotDate.toISOString().slice(0, 10),
      quarter: quarter.label,
      agents: snapshotted,
      at: new Date().toISOString(),
    }),
  );

  return NextResponse.json({
    snapshotDate: snapshotDate.toISOString().slice(0, 10),
    quarter: quarter.label,
    agents: snapshotted,
  });
}

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}
