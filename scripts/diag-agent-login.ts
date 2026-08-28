/* eslint-disable */
// Why can't a selling agent sign in at /agent/login?
//
// Walks the exact chain signInAgent() + requireAgent() depend on:
//   auth.users (password/confirmation) → xsystem.profiles (role/active)
//   → xsystem.selling_agents (status/link), then prints the session history
//   so you can see whether sign-ins are actually landing.
//
// Usage: npx tsx scripts/diag-agent-login.ts [code-or-email]   (default: all)
import { config } from "dotenv";
config({ path: ".env" });

import { PrismaClient } from "@/generated/prisma";
import { createClient } from "@supabase/supabase-js";

const prisma = new PrismaClient();
const target = process.argv[2]?.trim() ?? null;

function admin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase URL / service-role key missing from .env");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function main() {
  const agents = await prisma.sellingAgent.findMany({
    where: target
      ? {
          OR: [
            { code: { equals: target, mode: "insensitive" } },
            { email: { equals: target, mode: "insensitive" } },
          ],
        }
      : undefined,
    orderBy: { code: "asc" },
  });
  if (!agents.length) {
    console.log("No selling_agents row for", target);
    return;
  }

  const sb = admin();

  for (const agent of agents) {
    console.log(`\n=== ${agent.code} — ${agent.fullName} <${agent.email}> ===`);
    console.log(`[1] selling_agents: status=${agent.status} userId=${agent.userId ?? "(null)"}`
      + ` approvedAt=${agent.approvedAt?.toISOString().slice(0, 10) ?? "(null)"}`);

    const profile = agent.userId
      ? await prisma.profile.findUnique({ where: { id: agent.userId } })
      : await prisma.profile.findFirst({ where: { email: { equals: agent.email, mode: "insensitive" } } });
    console.log("[2] profiles     :", profile
      ? `role=${profile.role} isActive=${profile.isActive}`
      : "(no row — sign-in is rejected as 'not a selling-agent account')");

    // auth.users: read it directly. listUsers() does NOT populate identities,
    // and only the table knows whether a password was ever set.
    const rows: any[] = await prisma.$queryRawUnsafe(
      `select u.id, u.email,
              (u.encrypted_password is null or u.encrypted_password = '') as no_password,
              u.email_confirmed_at, u.last_sign_in_at, u.banned_until, u.deleted_at,
              u.confirmation_token <> '' as invite_outstanding,
              u.recovery_token <> '' as reset_outstanding,
              (select count(*) from auth.identities i where i.user_id = u.id) as identities
         from auth.users u where lower(u.email) = $1`,
      agent.email.toLowerCase(),
    );
    const u = rows[0];
    if (!u) {
      console.log("[3] auth.users   : (no row)");
    } else {
      console.log(`[3] auth.users   : password=${u.no_password ? "NOT SET" : "set"}`
        + ` confirmed=${u.email_confirmed_at ? String(u.email_confirmed_at).slice(0, 19) : "NO"}`
        + ` lastSignIn=${u.last_sign_in_at ? String(u.last_sign_in_at).slice(0, 19) : "never"}`
        + ` banned=${u.banned_until ?? "no"} inviteOutstanding=${u.invite_outstanding}`
        + ` resetOutstanding=${u.reset_outstanding} identities=${Number(u.identities)}`);

      const { data } = await sb.auth.admin.getUserById(u.id);
      const factors = (data?.user as any)?.factors ?? [];
      console.log("    mfa factors  :", factors.length
        ? factors.map((f: any) => `${f.factor_type}/${f.status}`).join(",")
        : "(none — no MFA challenge on sign-in)");
      console.log("    xsystem_role :", (data?.user?.user_metadata as any)?.xsystem_role ?? "(unset — middleware will bounce off /agent)");

      // Session history. A refresh (parent set) followed seconds later by a
      // fresh sign-in (no parent) = the agent re-typed their password while
      // already holding a valid session, i.e. they were sitting on the login
      // page. A long gap with no rows at all = they never got in.
      const sess: any[] = await prisma.$queryRawUnsafe(
        `select s.created_at, s.updated_at, s.aal, s.user_agent
           from auth.sessions s where s.user_id = $1::uuid
          order by s.created_at desc limit 8`, u.id);
      console.log("[4] sessions (newest first):");
      for (const s of sess) {
        console.log(`      ${String(s.created_at).slice(0, 19)} → last used ${String(s.updated_at).slice(0, 19)}`
          + `  ${s.aal}  ${(s.user_agent ?? "").slice(0, 24)}`);
      }
      if (!sess.length) console.log("      (no sessions — nobody has ever completed a sign-in)");
    }

    // Verdict against the code path in src/app/agent/login/actions.ts.
    const why =
      !u ? "no auth.users row — the agent was never invited"
      : u.deleted_at ? "auth user is soft-deleted"
      : u.banned_until ? "auth user is banned"
      : u.no_password ? "invite never accepted — no password set (resend the invite)"
      : !u.email_confirmed_at ? "email never confirmed — the set-password link was never used"
      : !profile ? "no xsystem.profiles row"
      : !profile.isActive ? "profile.isActive = false"
      : profile.role !== "selling_agent" ? `profile role is ${profile.role}`
      : agent.userId && profile.id !== agent.userId ? "selling_agents.userId points at a different profile"
      : "auth chain intact — sign-in works; any failure is after the password check";
    console.log("[5] verdict      :", why);
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
