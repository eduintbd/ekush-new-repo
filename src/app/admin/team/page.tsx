// /admin/team — back-office team management. Admin invites + manages
// staff with roles admin / accountant / auditor. Mirrors the portal's
// /admin/settings/team page so the admin has a familiar UI across both
// systems. Selling-agent provisioning lives in /admin/agents.

import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { adminClientAvailable, createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  inviteMember,
  changeRole,
  deactivateMember,
  reactivateMember,
  resendInvite,
} from "./actions";

type Search = { ok?: string; error?: string };

const STAFF_ROLES = ["admin", "checker", "accountant", "auditor"] as const;

const ROLE_DESC: Record<(typeof STAFF_ROLES)[number], string> = {
  admin: "Full access including team management. Only admins can invite or change roles.",
  checker: "Co-admin for accounting — same authority as admin on masters, fiscal-year close, tax provision, FVA, journals. Cannot manage the team.",
  accountant: "Day-to-day entries: journals, prices, portfolio, bank-recon. No masters or FY close.",
  auditor: "Read-only. All statements + activity log; no edit buttons render.",
};

export const metadata = { title: "Team — Admin" };

export default async function TeamPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const me = await requireRole(["admin"]);
  const sp = await searchParams;

  const members = await prisma.profile
    .findMany({
      where: { role: { in: ["admin", "checker", "accountant", "auditor"] } },
      orderBy: [{ isActive: "desc" }, { role: "asc" }, { email: "asc" }],
    })
    .catch(() => []);

  // Last-sign-in is in auth.users, not in our Profile mirror. Look it
  // up via the admin client and merge by id. Skips gracefully if the
  // service-role key isn't configured.
  const adminAvailable = adminClientAvailable();
  const lastSignInById = new Map<string, string | null>();
  if (adminAvailable) {
    try {
      const admin = createSupabaseAdminClient()!;
      const { data } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
      for (const u of data?.users ?? []) {
        lastSignInById.set(u.id, u.last_sign_in_at ?? null);
      }
    } catch {
      // Best-effort — leave map empty.
    }
  }

  const activeAdmins = members.filter((m) => m.role === "admin" && m.isActive).length;

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10 dark:bg-zinc-950">
      <div className="mx-auto max-w-5xl">
        <div className="text-xs uppercase tracking-widest text-zinc-500">
          <Link href="/dashboard" className="hover:text-zinc-700 dark:hover:text-zinc-300">
            ← Dashboard
          </Link>
          <span className="mx-1.5 text-zinc-400">/</span>
          <span className="normal-case text-zinc-700 dark:text-zinc-300">Team</span>
        </div>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Team &amp; Permissions
        </h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Back-office staff with X-System access. Selling agents are managed at{" "}
          <Link href="/admin/agents" className="underline">/admin/agents</Link>.
        </p>

        {sp.ok && <Banner kind="success">{sp.ok}</Banner>}
        {sp.error && <Banner kind="error">{sp.error}</Banner>}

        {!adminAvailable && (
          <Banner kind="error">
            <strong>SUPABASE_SERVICE_ROLE_KEY is not configured.</strong> Invite + resend will
            fail until it&apos;s set on the deployment. Role / activation changes still work.
          </Banner>
        )}

        {/* Role legend */}
        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {STAFF_ROLES.map((r) => (
            <div
              key={r}
              className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900"
            >
              <p className="text-sm font-semibold capitalize text-zinc-900 dark:text-zinc-50">
                {r}
              </p>
              <p className="mt-0.5 text-xs text-zinc-600 dark:text-zinc-400">{ROLE_DESC[r]}</p>
            </div>
          ))}
        </div>

        {/* Members table */}
        <div className="mt-6 overflow-x-auto rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
            <thead className="bg-zinc-50 dark:bg-zinc-950">
              <tr>
                <Th>Member</Th>
                <Th>Email</Th>
                <Th>Role</Th>
                <Th>Last sign-in</Th>
                <Th>Status</Th>
                <Th />
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {members.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-4 py-6 text-center text-sm italic text-zinc-500"
                  >
                    No team members yet — invite one below.
                  </td>
                </tr>
              ) : (
                members.map((m) => {
                  const lastSi = lastSignInById.get(m.id);
                  return (
                    <tr key={m.id} className={!m.isActive ? "opacity-50" : ""}>
                      <Td className="font-medium">
                        {m.fullName ?? "—"}
                        {m.id === me.id && (
                          <span className="ml-2 rounded bg-sky-100 px-1.5 py-0.5 text-[9px] font-medium uppercase text-sky-800 dark:bg-sky-950 dark:text-sky-200">
                            you
                          </span>
                        )}
                      </Td>
                      <Td className="font-mono text-xs">{m.email}</Td>
                      <Td>
                        <form action={changeRole} className="inline">
                          <input type="hidden" name="profileId" value={m.id} />
                          <select
                            name="role"
                            defaultValue={m.role}
                            onChange={undefined}
                            disabled={m.id === me.id}
                            className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-950 disabled:opacity-60"
                          >
                            {STAFF_ROLES.map((r) => (
                              <option key={r} value={r}>
                                {r}
                              </option>
                            ))}
                          </select>
                          <button
                            type="submit"
                            disabled={m.id === me.id}
                            className="ml-1.5 text-[10px] text-zinc-600 underline disabled:cursor-not-allowed disabled:opacity-40 dark:text-zinc-400"
                          >
                            save
                          </button>
                        </form>
                      </Td>
                      <Td className="text-xs text-zinc-500">
                        {lastSi ? new Date(lastSi).toISOString().slice(0, 16).replace("T", " ") : "—"}
                      </Td>
                      <Td>
                        {m.isActive ? (
                          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium uppercase text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                            active
                          </span>
                        ) : (
                          <span className="rounded-full bg-zinc-200 px-2 py-0.5 text-[10px] font-medium uppercase text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                            inactive
                          </span>
                        )}
                      </Td>
                      <Td>
                        <div className="flex items-center gap-3 text-[10px]">
                          {m.isActive ? (
                            <form
                              action={deactivateMember}
                              data-confirm={`Deactivate ${m.email}? They'll lose all access.`}
                              className="inline"
                            >
                              <input type="hidden" name="profileId" value={m.id} />
                              <button
                                type="submit"
                                disabled={m.id === me.id || (m.role === "admin" && activeAdmins <= 1)}
                                className="text-red-600 hover:underline disabled:cursor-not-allowed disabled:opacity-40 dark:text-red-400"
                              >
                                deactivate
                              </button>
                            </form>
                          ) : (
                            <form action={reactivateMember} className="inline">
                              <input type="hidden" name="profileId" value={m.id} />
                              <button
                                type="submit"
                                className="text-emerald-700 hover:underline dark:text-emerald-300"
                              >
                                reactivate
                              </button>
                            </form>
                          )}
                          {adminAvailable && (
                            <form
                              action={resendInvite}
                              className="inline"
                              data-confirm={`Re-send invite email to ${m.email}?`}
                            >
                              <input type="hidden" name="profileId" value={m.id} />
                              <button
                                type="submit"
                                className="text-zinc-600 hover:underline dark:text-zinc-400"
                              >
                                resend invite
                              </button>
                            </form>
                          )}
                        </div>
                      </Td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Invite form */}
        <section className="mt-8 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">
            Invite a member
          </h2>
          <p className="mt-1 text-xs text-zinc-500">
            Sends a magic-link sign-up email via Supabase. If the email already has a Supabase
            account (e.g. they&apos;re a portal user), we attach the X-System profile without
            re-sending. Admin / accountant must enrol TOTP on first sign-in.
          </p>
          <form action={inviteMember} className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-4">
            <label className="block text-xs sm:col-span-2">
              <span className="font-medium text-zinc-600 dark:text-zinc-400">Email *</span>
              <input
                name="email"
                type="email"
                required
                placeholder="bookkeeper@ekushwml.com"
                className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-950"
              />
            </label>
            <label className="block text-xs">
              <span className="font-medium text-zinc-600 dark:text-zinc-400">Full name *</span>
              <input
                name="fullName"
                required
                placeholder="Jane Doe"
                className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-950"
              />
            </label>
            <label className="block text-xs">
              <span className="font-medium text-zinc-600 dark:text-zinc-400">Role *</span>
              <select
                name="role"
                defaultValue="accountant"
                className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-950"
              >
                {STAFF_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="submit"
              disabled={!adminAvailable}
              className="self-end rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
            >
              {adminAvailable ? "Send invite" : "Service-role key required"}
            </button>
          </form>
        </section>
      </div>
    </main>
  );
}

function Banner({ kind, children }: { kind: "success" | "error"; children: React.ReactNode }) {
  const cls =
    kind === "success"
      ? "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
      : "border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-300";
  return <div className={`mt-4 rounded-md border px-3 py-2 text-sm ${cls}`}>{children}</div>;
}

function Th({ children }: { children?: React.ReactNode }) {
  return (
    <th className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
      {children}
    </th>
  );
}

function Td({
  children,
  className = "",
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return <td className={`px-4 py-2 ${className}`}>{children}</td>;
}
