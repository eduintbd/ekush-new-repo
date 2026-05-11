// GET /api/health — public liveness + readiness probe for monitoring.
// Returns 200 + JSON with `db: 'ok'|'down'` and `auth: 'ok'|'unconfigured'`.
// Used by uptime monitors and the log-drain freshness check.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const at = new Date().toISOString();
  let dbStatus: "ok" | "down" = "down";
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbStatus = "ok";
  } catch {
    dbStatus = "down";
  }
  const authStatus =
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
      ? "ok"
      : "unconfigured";

  const overall = dbStatus === "ok" ? 200 : 503;
  return NextResponse.json(
    { at, db: dbStatus, auth: authStatus },
    { status: overall, headers: { "Cache-Control": "no-store" } },
  );
}
