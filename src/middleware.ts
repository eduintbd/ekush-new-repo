// Route-level auth: refresh Supabase session, then enforce portal-by-role.
//
//   Public:                 /  /login  /agent/login  + Next.js internals
//   Staff portal:           everything else under root
//   Agent portal:           /agent/* (except /agent/login)
//
// We do NOT load the Profile here (avoid Prisma/edge-runtime conflict). The
// Supabase user has user_metadata.xsystem_role set at sign-in time by the
// role-aware sign-in action in src/app/login/actions.ts. The full profile
// check happens in src/lib/auth.ts requireStaff/requireAgent helpers.
//
// We use `xsystem_role` rather than the conventional `role` field so this
// app can co-tenant Supabase auth.users with ekush-web — which already
// uses `user_metadata.role` for its own SUPER_ADMIN/INVESTOR taxonomy.

import { NextResponse, type NextRequest } from "next/server";
import { updateSupabaseSession } from "@/lib/supabase/middleware";

const STAFF_ROLES = new Set(["admin", "checker", "accountant", "auditor"]);

function isPublic(pathname: string): boolean {
  return (
    pathname === "/" ||
    pathname === "/login" ||
    pathname === "/agent/login" ||
    // Pre-auth agent pages: the user is NOT signed in yet. set-password
    // establishes the session client-side from the recovery link's URL hash,
    // so the middleware must NOT bounce it (a server redirect would strip the
    // hash before the client can read it).
    pathname === "/agent/set-password" ||
    pathname === "/agent/forgot-password" ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/api/health") ||
    // Cron routes carry no Supabase session — Vercel Cron calls them with
    // `Authorization: Bearer $CRON_SECRET`. Without this they were redirected
    // to /login (307) before the handler ever ran, which is why NO scheduled
    // job had ever executed: no trail, no upfront, no investor linking. They
    // are not unprotected — every one of them gates on authoriseCron(), which
    // fails closed when CRON_SECRET is unset.
    pathname.startsWith("/api/cron/")
  );
}

export async function middleware(req: NextRequest) {
  const { res, user } = await updateSupabaseSession(req);
  const { pathname } = req.nextUrl;

  if (isPublic(pathname)) return res;

  // Unauthenticated. API routes get a 401 — redirecting them to a login PAGE
  // hands a `fetch` or a download link a chunk of HTML with a 200-ish status,
  // which surfaces as a corrupt file rather than "you are signed out".
  if (!user) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const loginUrl = req.nextUrl.clone();
    loginUrl.pathname = pathname.startsWith("/agent") ? "/agent/login" : "/login";
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Authenticated — gate by role from user_metadata.xsystem_role. Profile
  // lookup happens in server components via src/lib/auth.ts (avoids Prisma
  // at edge). We deliberately ignore user_metadata.role to avoid colliding
  // with ekush-web, which writes that field for its own purposes.
  const role = (user.user_metadata?.xsystem_role as string | undefined) ?? null;
  // `/api/agent/*` is agent territory too. Without it a signed-in agent's own
  // API calls fell through to the staff branch below and were redirected to
  // /agent with the query string intact — so every statement PDF, the
  // commission workbook and the create-investor POST came back as the
  // dashboard's HTML instead of a file. That is the
  // "/agent?code=A00005&type=portfolio&fundCode=EFUF" the agent was landing on.
  const onAgentRoute = pathname.startsWith("/agent") || pathname.startsWith("/api/agent");
  // /account/* (MFA management) is reachable by any authenticated role.
  const onSharedRoute = pathname.startsWith("/account");

  if (onSharedRoute) return res;

  const isApi = pathname.startsWith("/api/");
  /** Wrong role: APIs get a status, pages get sent somewhere useful. */
  const deny = (to: string) => {
    if (isApi) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    const url = req.nextUrl.clone();
    url.pathname = to;
    return NextResponse.redirect(url);
  };

  if (onAgentRoute && role !== "selling_agent") return deny("/");
  if (!onAgentRoute && role === "selling_agent") return deny("/agent");
  // Staff route, role is staff or unset (legacy): allow. Page-level
  // requireStaff/requireRole gives the strict check.
  if (!onAgentRoute && role !== null && !STAFF_ROLES.has(role)) return deny("/");

  return res;
}

export const config = {
  matcher: [
    // All routes except Next.js internals + static assets
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|woff2?)$).*)",
  ],
};
