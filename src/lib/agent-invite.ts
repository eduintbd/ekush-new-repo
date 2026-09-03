// Selling-agent login provisioning. Mirrors how the portal onboards users:
// the agent never receives a password — on approval we create their Supabase
// auth user and email them a one-time set-password TICKET. The agent sets
// their own password at /agent/set-password.
//
// ─── Why a ticket and not the Supabase link ────────────────────────────
// We used to email Supabase's own `…/auth/v1/verify?token=…` URL. GoTrue burns
// that token on the FIRST GET, and corporate mail gateways (Defender
// SafeLinks, Proofpoint URL Defense) plus chat link-preview crawlers fetch
// every URL in a message. Fintra's gateway spent the token 17 seconds after
// the invite email and 19 seconds after the resend — before the agent ever
// clicked — so his click always landed on `error_code=otp_expired`.
//
// The emailed URL is now a ticket on our own domain. A GET renders a page and
// changes nothing. The Supabase link is minted AND redeemed inside the POST
// behind a button (redeemPasswordTicket), which no prefetcher issues, so the
// Supabase token lives for milliseconds server-side and never travels by
// email. It also means the ticket can outlive Supabase's own OTP expiry: we
// mint the underlying link fresh at redemption time.

import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { headers } from "next/headers";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { prisma } from "@/lib/prisma";
import { sendMail, agentInviteEmail } from "@/lib/mail";

/** How long an emailed ticket stays usable. A first-time agent may be waiting
 *  on paperwork, so onboarding gets a week; a reset is a deliberate act with a
 *  person at the keyboard, so it gets a day. */
const TICKET_TTL_MS = {
  onboarding: 7 * 24 * 60 * 60 * 1000,
  reset: 24 * 60 * 60 * 1000,
};

export interface AgentInviteResult {
  ok: boolean;
  userId?: string;
  isNewUser?: boolean;
  emailSent?: boolean;
  error?: string;
  /** The one-time set-password link, so the admin UI can show it as a fallback
   *  when email delivery is unreliable. Safe to paste into WhatsApp/Teams —
   *  a preview crawler's GET cannot spend it. */
  actionUrl?: string;
}

/** Absolute base URL of this deployment, from the incoming request host. */
export async function requestBaseUrl(): Promise<string> {
  const h = await headers();
  const host = h.get("host") ?? "x.ekushwml.com";
  const proto = host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https";
  return `${proto}://${host}`;
}

/** Find an existing Supabase auth user by email (null if none). */
export async function findAuthUserByEmail(
  admin: SupabaseClient,
  email: string,
): Promise<User | null> {
  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) return null;
  const lower = email.toLowerCase();
  return data.users.find((u) => u.email?.toLowerCase() === lower) ?? null;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Issue a fresh ticket for `email` and void any outstanding ones, so
 * "Resend invite" keeps the old semantics: the previous link stops working.
 * Returns the raw token — the only place it ever exists in plaintext.
 */
async function issueTicket(opts: {
  email: string;
  agentId: string | null;
  isReset: boolean;
}): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const ttl = opts.isReset ? TICKET_TTL_MS.reset : TICKET_TTL_MS.onboarding;

  await prisma.$transaction([
    prisma.agentPasswordTicket.updateMany({
      where: { email: opts.email, redeemedAt: null },
      data: { redeemedAt: new Date() },
    }),
    prisma.agentPasswordTicket.create({
      data: {
        tokenHash: hashToken(token),
        email: opts.email,
        agentId: opts.agentId,
        isReset: opts.isReset,
        expiresAt: new Date(Date.now() + ttl),
      },
    }),
  ]);

  return token;
}

/**
 * Ensure the agent has a Supabase auth user, issue a set-password ticket
 * pointing at /agent/set-password, and email it. Does NOT touch xsystem
 * accounting tables — the caller wires Profile + sellingAgent.userId in its
 * audited transaction.
 *
 * `isNewUser` is decided by whether the Supabase invite succeeded: the invite
 * call is what CREATES the auth user, and it fails for an address that already
 * has one. We discard the link it returns — the ticket is what gets emailed.
 */
export async function mintAndSendAgentInvite(
  agent: { id?: string; email: string; fullName: string; code: string },
  baseUrl: string,
): Promise<AgentInviteResult> {
  const admin = createSupabaseAdminClient();
  if (!admin) return { ok: false, error: "SUPABASE_SERVICE_ROLE_KEY is not configured on this deployment." };

  const email = agent.email.trim().toLowerCase();
  const origin = baseUrl.replace(/\/$/, "");

  // Creates the auth user when the address is new. The action_link it hands
  // back is deliberately dropped: emailing it is the bug this flow exists to
  // fix, and an unclicked invite token simply lapses.
  const invite = await admin.auth.admin.generateLink({
    type: "invite",
    email,
    options: { redirectTo: `${origin}/agent/set-password` },
  });

  let userId: string;
  let isNewUser: boolean;

  if (!invite.error && invite.data?.user) {
    userId = invite.data.user.id;
    isNewUser = true;
  } else {
    // Already registered (the usual case for a resend) — look the user up
    // rather than minting a recovery link just to learn their id.
    const existing = await findAuthUserByEmail(admin, email);
    if (!existing) {
      return { ok: false, error: invite.error?.message ?? "Could not create the agent's login." };
    }
    userId = existing.id;
    isNewUser = false;
  }

  const token = await issueTicket({
    email,
    agentId: agent.id ?? null,
    isReset: !isNewUser,
  });
  const actionUrl = `${origin}/agent/set-password?t=${token}`;

  const mail = agentInviteEmail({
    fullName: agent.fullName,
    code: agent.code,
    actionUrl,
    loginUrl: `${origin}/agent/login`,
    isReset: !isNewUser,
  });
  const sent = await sendMail({ to: email, subject: mail.subject, html: mail.html, text: mail.text });

  return {
    ok: true,
    userId,
    isNewUser,
    emailSent: sent.ok,
    error: sent.ok ? undefined : ("error" in sent ? sent.error : undefined),
    actionUrl,
  };
}

export type TicketState = "valid" | "unknown" | "used" | "expired";

/**
 * Read-only look at a ticket, so a GET can render an honest page ("already
 * used" / "expired") instead of a button that is going to fail. Deliberately
 * has no side effects: this runs for link-prefetchers too.
 */
export async function peekTicket(token: string): Promise<TicketState> {
  if (!token) return "unknown";
  const ticket = await prisma.agentPasswordTicket.findUnique({
    where: { tokenHash: hashToken(token) },
    select: { redeemedAt: true, expiresAt: true },
  });
  if (!ticket) return "unknown";
  if (ticket.redeemedAt) return "used";
  if (ticket.expiresAt <= new Date()) return "expired";
  return "valid";
}

export type TicketRedemption =
  | { ok: true; accessToken: string; refreshToken: string; email: string }
  | { ok: false; error: string };

/**
 * Spend a ticket and return a live Supabase session for its email.
 *
 * MUST only ever be called from a POST — that is the entire protection against
 * the link-prefetching that broke the old flow. The claim is an atomic
 * `updateMany` on (unredeemed, unexpired), so a double-submit or a race spends
 * the ticket exactly once.
 *
 * The Supabase recovery link is minted here and consumed on the next line, in
 * this process. It is never written down and never leaves the server.
 */
export async function redeemPasswordTicket(
  token: string,
  baseUrl: string,
): Promise<TicketRedemption> {
  const admin = createSupabaseAdminClient();
  if (!admin) return { ok: false, error: "Auth is not configured on this deployment." };
  if (!token) return { ok: false, error: "This link is missing its token." };

  const tokenHash = hashToken(token);
  const ticket = await prisma.agentPasswordTicket.findUnique({ where: { tokenHash } });
  if (!ticket) return { ok: false, error: "This link is not valid." };
  if (ticket.redeemedAt) return { ok: false, error: "This link has already been used." };
  if (ticket.expiresAt <= new Date()) return { ok: false, error: "This link has expired." };

  // A suspended agent must not be able to resurrect access from an old email.
  const agent = await prisma.sellingAgent.findFirst({ where: { email: ticket.email } });
  if (agent && agent.status === "suspended") {
    return { ok: false, error: "This agent account is suspended. Contact Ekush Wealth Management." };
  }

  // Claim it. `redeemedAt: null` in the filter is the lock — a second request
  // that got this far updates 0 rows and is refused.
  const claim = await prisma.agentPasswordTicket.updateMany({
    where: { tokenHash, redeemedAt: null },
    data: { redeemedAt: new Date() },
  });
  if (claim.count === 0) return { ok: false, error: "This link has already been used." };

  // `redirectTo` only decides the Location we are about to discard — we read
  // the fragment off the 303 rather than following it — but it still has to
  // satisfy GoTrue's allow-list, so send our real origin.
  const link = await admin.auth.admin.generateLink({
    type: "recovery",
    email: ticket.email,
    options: { redirectTo: `${baseUrl.replace(/\/$/, "")}/agent/set-password` },
  });
  const actionLink = link.data?.properties?.action_link;
  if (link.error || !actionLink) {
    return { ok: false, error: link.error?.message ?? "Could not start a password session." };
  }

  // Consume it right here. GoTrue answers a verify GET with a 303 whose
  // Location carries the session in the URL fragment; we want the tokens, not
  // the redirect, so redirects are not followed.
  const res = await fetch(actionLink, { redirect: "manual" });
  const location = res.headers.get("location") ?? "";
  const fragment = new URLSearchParams(location.split("#")[1] ?? "");

  const accessToken = fragment.get("access_token");
  const refreshToken = fragment.get("refresh_token");
  if (!accessToken || !refreshToken) {
    const why = fragment.get("error_description") ?? fragment.get("error") ?? `status ${res.status}`;
    return { ok: false, error: `Could not start a password session (${why}).` };
  }

  return { ok: true, accessToken, refreshToken, email: ticket.email };
}
