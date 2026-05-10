// Route-level auth: refresh Supabase session, then enforce portal-by-role.
//
//   Public:                 /  /login  /agent/login  + Next.js internals
//   Staff portal:           everything else under root
//   Agent portal:           /agent/* (except /agent/login)
//
// We do NOT load the Profile here (avoid Prisma/edge-runtime conflict). The
// Supabase user has user_metadata.role set at sign-in time by the role-aware
// sign-in action in src/app/login/actions.ts. The full profile check happens
// in src/lib/auth.ts requireStaff/requireAgent helpers.

import { NextResponse, type NextRequest } from "next/server";
import { updateSupabaseSession } from "@/lib/supabase/middleware";

const STAFF_ROLES = new Set(["admin", "accountant", "auditor"]);

function isPublic(pathname: string): boolean {
  return (
    pathname === "/" ||
    pathname === "/login" ||
    pathname === "/agent/login" ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/api/health")
  );
}

export async function proxy(req: NextRequest) {
  const { res, user } = await updateSupabaseSession(req);
  const { pathname } = req.nextUrl;

  if (isPublic(pathname)) return res;

  // Unauthenticated → send to the right login page based on the path.
  if (!user) {
    const loginUrl = req.nextUrl.clone();
    loginUrl.pathname = pathname.startsWith("/agent") ? "/agent/login" : "/login";
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Authenticated — gate by role from user_metadata. Profile lookup happens
  // in server components via src/lib/auth.ts (avoids Prisma at edge).
  const role = (user.user_metadata?.role as string | undefined) ?? null;
  const onAgentRoute = pathname.startsWith("/agent");

  if (onAgentRoute && role !== "selling_agent") {
    const home = req.nextUrl.clone();
    home.pathname = "/";
    return NextResponse.redirect(home);
  }
  if (!onAgentRoute && role === "selling_agent") {
    const agent = req.nextUrl.clone();
    agent.pathname = "/agent";
    return NextResponse.redirect(agent);
  }
  // Staff route, role is staff or unset (legacy): allow. Page-level
  // requireStaff/requireRole gives the strict check.
  if (!onAgentRoute && role !== null && !STAFF_ROLES.has(role)) {
    const home = req.nextUrl.clone();
    home.pathname = "/";
    return NextResponse.redirect(home);
  }

  return res;
}

export const config = {
  matcher: [
    // All routes except Next.js internals + static assets
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|woff2?)$).*)",
  ],
};
