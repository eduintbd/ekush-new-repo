"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { Prisma, UserRole } from "@/generated/prisma";
import { prisma, withActor } from "@/lib/prisma";
import { requireRole } from "@/lib/auth";
import { postTrailFromPreview } from "@/lib/post-trail";
import { parseAsOf } from "@/lib/agent-commission-preview";
import {
  accrueAgentCommission,
  describeSplit,
  parseDateOnly,
  payAgentCommission,
  reverseCommissionRun,
  PayoutError,
} from "@/lib/commission-payout";
import { runUpfront } from "@/lib/run-upfront";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  findAuthUserByEmail,
  mintAndSendAgentInvite,
  requestBaseUrl,
} from "@/lib/agent-invite";

const NEW_AGENT_PATH = "/admin/agents/new";

function backToInvite(msg: string): never {
  redirect(`${NEW_AGENT_PATH}?error=${encodeURIComponent(msg)}`);
}

const FUND_CATEGORIES = ["equity", "fixed_income"] as const;
type FundCategoryT = (typeof FUND_CATEGORIES)[number];

function parsePct(raw: string): number | null {
  const v = Number(raw);
  if (!Number.isFinite(v)) return null;
  // Accept either "0.0020" (decimal) or "0.20" (percent literal). Heuristic:
  // anything ≥ 1 we treat as % and divide by 100. Anything < 1 stays as-is.
  return v >= 1 ? v / 100 : v;
}

/** Trail cadence from the form; monthly is the default/preferred. */
function parseFrequency(raw: string): "monthly" | "quarterly" {
  return raw === "quarterly" ? "quarterly" : "monthly";
}

const DEFAULT_TERM_EQUITY = {
  upfrontPct: 0.002, // 0.20%
  trailY1PctPa: 0.004, // 0.40%
  trailY2PlusPctPa: 0.0035, // 0.35%
};
const DEFAULT_TERM_FIXED_INCOME = {
  upfrontPct: 0.002, // 0.20%
  trailY1PctPa: 0.002, // 0.20%
  trailY2PlusPctPa: 0.0015, // 0.15%
};

/**
 * Approve a pending agent: provision their Supabase login, email a one-time
 * set-password link (via the portal SMTP), create the selling_agent Profile,
 * link it to the agent, and seed default commission terms.
 *
 * The email is the whole point of approval per ops — an agent who cannot be
 * emailed a link cannot sign in, so provisioning runs first and a failure
 * blocks the approval (nothing half-done). Re-running is safe: terms are only
 * seeded once, and the invite becomes a fresh recovery link.
 */
export async function approveAgent(id: string): Promise<void> {
  const me = await requireRole(["admin", "checker"]);
  const agent = await prisma.sellingAgent.findUnique({ where: { id } });
  if (!agent) redirect("/admin/agents?error=Agent+not+found");

  const admin = createSupabaseAdminClient();
  if (!admin) {
    redirect(`/admin/agents/${id}?error=${encodeURIComponent("SUPABASE_SERVICE_ROLE_KEY is not configured — cannot provision a login.")}`);
  }

  // Guard: if this email is already a Supabase user with a non-agent Profile
  // (e.g. a staff member), refuse — approving would send them a reset link and
  // overwrite their role. Ask for a different email.
  const existingUser = await findAuthUserByEmail(admin!, agent!.email);
  if (existingUser) {
    const existingProfile = await prisma.profile.findUnique({ where: { id: existingUser.id } });
    if (existingProfile && existingProfile.role !== UserRole.selling_agent) {
      redirect(
        `/admin/agents/${id}?error=${encodeURIComponent(`This email already belongs to a ${existingProfile.role} account. Use a different email for the agent.`)}`,
      );
    }
  }

  // Provision the login + email the set-password link.
  const invite = await mintAndSendAgentInvite(
    { email: agent!.email, fullName: agent!.fullName, code: agent!.code },
    await requestBaseUrl(),
  );
  if (!invite.ok || !invite.userId) {
    redirect(`/admin/agents/${id}?error=${encodeURIComponent(`Approval blocked — could not provision the login: ${invite.error ?? "unknown error"}`)}`);
  }

  const today = new Date();
  const hasTerms = (await prisma.agentTerm.count({ where: { agentId: id } })) > 0;

  await withActor(me.id, async (tx) => {
    // Create/refresh the agent's Profile (role gates /agent/* access) and link.
    await tx.profile.upsert({
      where: { id: invite.userId! },
      create: {
        id: invite.userId!,
        email: agent!.email,
        fullName: agent!.fullName,
        role: UserRole.selling_agent,
        isActive: true,
      },
      update: { role: UserRole.selling_agent, isActive: true },
    });
    await tx.sellingAgent.update({
      where: { id },
      data: { status: "approved", approvedAt: today, approvedBy: me.id, userId: invite.userId! },
    });
    if (!hasTerms) {
      await tx.agentTerm.create({
        data: {
          agentId: id,
          fundCategory: "equity",
          ...DEFAULT_TERM_EQUITY,
          trailFrequency: "monthly",
          effectiveFrom: today,
          createdBy: me.id,
        },
      });
      await tx.agentTerm.create({
        data: {
          agentId: id,
          fundCategory: "fixed_income",
          ...DEFAULT_TERM_FIXED_INCOME,
          trailFrequency: "monthly",
          effectiveFrom: today,
          createdBy: me.id,
        },
      });
    }
  });

  revalidatePath("/admin/agents");
  revalidatePath(`/admin/agents/${id}`);
  const emailNote = invite.emailSent
    ? `A set-password email was sent to ${agent!.email}.`
    : `Approved, but the email did not send (${invite.error ?? "unknown error"}). Send the agent the link below.`;
  const params = new URLSearchParams({ ok: `Agent approved. ${emailNote}` });
  if (invite.actionUrl) params.set("link", invite.actionUrl);
  redirect(`/admin/agents/${id}?${params.toString()}`);
}

/**
 * Re-send the set-password link to an agent (e.g. the first email bounced or
 * the link expired). Works whether or not the agent already has a login —
 * mintAndSendAgentInvite issues an invite for a new user or a recovery link
 * for an existing one. Backfills the Profile/link if they were missing.
 */
export async function resendAgentInvite(id: string): Promise<void> {
  const me = await requireRole(["admin", "checker"]);
  const agent = await prisma.sellingAgent.findUnique({ where: { id } });
  if (!agent) redirect("/admin/agents?error=Agent+not+found");

  const invite = await mintAndSendAgentInvite(
    { email: agent!.email, fullName: agent!.fullName, code: agent!.code },
    await requestBaseUrl(),
  );
  if (!invite.ok || !invite.userId) {
    redirect(`/admin/agents/${id}?error=${encodeURIComponent(`Could not send the link: ${invite.error ?? "unknown error"}`)}`);
  }

  // Backfill the Profile + link if approval predated this flow.
  //
  // The minted userId can differ from the stored one when an admin has
  // changed the agent's email: the invite then targets a DIFFERENT auth
  // user. Re-point the agent at it, otherwise the agent signs in fine
  // (signInAgent only checks the Profile) but getAgentScope() looks the
  // agent up by userId, finds nothing, and shows an empty dashboard.
  const staleUserId = agent!.userId && agent!.userId !== invite.userId ? agent!.userId : null;

  await withActor(me.id, async (tx) => {
    await tx.profile.upsert({
      where: { id: invite.userId! },
      create: {
        id: invite.userId!,
        email: agent!.email,
        fullName: agent!.fullName,
        role: UserRole.selling_agent,
        isActive: true,
      },
      // Keep the Profile's email in step with the agent record, else the
      // two disagree after an email change.
      update: { email: agent!.email, isActive: true },
    });

    if (agent!.userId !== invite.userId) {
      await tx.sellingAgent.update({ where: { id }, data: { userId: invite.userId! } });
    }

    // Retire the previous login's selling-agent Profile. Without this the
    // old address keeps agent access — which matters most in exactly the
    // case that produces a stale id: the old auth user is shared with a
    // portal investor, who would otherwise retain a way into /agent/*.
    // Only the xsystem Profile is removed; the portal's own account
    // (public.users) is untouched.
    if (staleUserId) {
      await tx.profile.deleteMany({ where: { id: staleUserId, role: UserRole.selling_agent } });
    }
  });

  // Best-effort: drop the namespaced role claim from the retired login so
  // middleware stops routing it to /agent. Not security-critical
  // (requireAgent re-checks the Profile, which is now gone), so a failure
  // here must not fail the invite.
  if (staleUserId) {
    try {
      const admin = createSupabaseAdminClient();
      if (admin) {
        await admin.auth.admin.updateUserById(staleUserId, { user_metadata: { xsystem_role: null } });
      }
    } catch {
      // ignore
    }
  }

  revalidatePath(`/admin/agents/${id}`);
  const note = invite.emailSent
    ? `Set-password link re-sent to ${agent!.email}.`
    : `Link created but the email did not send (${invite.error ?? "unknown error"}). Send the agent the link below.`;
  const params = new URLSearchParams();
  params.set(invite.emailSent ? "ok" : "error", note);
  if (invite.actionUrl) params.set("link", invite.actionUrl);
  redirect(`/admin/agents/${id}?${params.toString()}`);
}

/**
 * Permanently delete an agent record. Admin-only. DB cascades remove the
 * agent's terms, investor links, upfront watermarks/suspensions, commission
 * runs and accruals; journals are preserved with their agent_id set to null
 * (SetNull), so the general ledger is untouched. Best-effort cleanup also
 * removes the agent's selling_agent Profile and Supabase auth user so no
 * orphan login lingers.
 */
export async function deleteAgent(id: string): Promise<void> {
  const me = await requireRole(["admin"]);
  const agent = await prisma.sellingAgent.findUnique({ where: { id } });
  if (!agent) redirect("/admin/agents?error=Agent+not+found");

  await withActor(me.id, (tx) => tx.sellingAgent.delete({ where: { id } }));

  // Login cleanup — non-fatal; the agent row is already gone. Only remove the
  // Profile/auth user if it is a selling_agent (never touch a shared staff login).
  if (agent!.userId) {
    try {
      const profile = await prisma.profile.findUnique({ where: { id: agent!.userId } });
      if (profile && profile.role === UserRole.selling_agent) {
        await prisma.profile.delete({ where: { id: agent!.userId } });
        const admin = createSupabaseAdminClient();
        if (admin) await admin.auth.admin.deleteUser(agent!.userId);
      }
    } catch {
      // ignore — deletion of the agent already succeeded
    }
  }

  revalidatePath("/admin/agents");
  redirect(`/admin/agents?ok=${encodeURIComponent(`Agent ${agent!.code} deleted.`)}`);
}

export async function suspendAgent(id: string): Promise<void> {
  const me = await requireRole(["admin", "checker"]);
  await withActor(me.id, async (tx) => {
    const agent = await tx.sellingAgent.update({
      where: { id },
      data: { status: "suspended" },
    });
    // Deactivate the login so the agent is immediately locked out of the
    // portal — requireAgent()/signInAgent both reject !isActive.
    if (agent.userId) {
      await tx.profile.update({ where: { id: agent.userId }, data: { isActive: false } });
    }
  });
  revalidatePath("/admin/agents");
  revalidatePath(`/admin/agents/${id}`);
}

export async function reinstateAgent(id: string): Promise<void> {
  const me = await requireRole(["admin", "checker"]);
  await withActor(me.id, async (tx) => {
    const agent = await tx.sellingAgent.update({
      where: { id },
      data: { status: "approved" },
    });
    if (agent.userId) {
      await tx.profile.update({ where: { id: agent.userId }, data: { isActive: true } });
    }
  });
  revalidatePath("/admin/agents");
  revalidatePath(`/admin/agents/${id}`);
}

/**
 * Add a new AgentTerm row for one fund category. Supersedes the currently
 * open (effectiveTo == null) term for the same category by stamping its
 * effectiveTo to `(newEffectiveFrom - 1 day)`. Idempotent at the row level:
 * if the supplied effectiveFrom matches an existing open term's effectiveFrom,
 * we update that row in-place instead of inserting a new one.
 */
export async function addAgentTerm(formData: FormData): Promise<void> {
  const me = await requireRole(["admin", "checker"]);
  const agentId = String(formData.get("agentId") ?? "").trim();
  const fundCategory = String(formData.get("fundCategory") ?? "").trim() as FundCategoryT;
  const upfront = parsePct(String(formData.get("upfrontPct") ?? ""));
  const trailY1 = parsePct(String(formData.get("trailY1PctPa") ?? ""));
  const trailY2 = parsePct(String(formData.get("trailY2PlusPctPa") ?? ""));
  const clawbackMonths = Number(formData.get("clawbackMonths") ?? "6") || 6;
  const clawbackPct = parsePct(String(formData.get("clawbackPct") ?? "1"));
  const trailFrequency = parseFrequency(String(formData.get("trailFrequency") ?? "monthly"));
  const effectiveFromRaw = String(formData.get("effectiveFrom") ?? "").trim();

  if (!agentId) redirect(`/admin/agents?error=Missing+agent`);
  if (!FUND_CATEGORIES.includes(fundCategory)) {
    redirect(`/admin/agents/${agentId}?error=Invalid+fund+category`);
  }
  if (upfront == null || trailY1 == null || trailY2 == null || clawbackPct == null) {
    redirect(`/admin/agents/${agentId}?error=All+percentages+must+be+numbers`);
  }
  if (!effectiveFromRaw) {
    redirect(`/admin/agents/${agentId}?error=Effective+from+date+is+required`);
  }
  const effectiveFrom = new Date(`${effectiveFromRaw}T00:00:00.000Z`);
  if (Number.isNaN(effectiveFrom.getTime())) {
    redirect(`/admin/agents/${agentId}?error=Invalid+effective+from+date`);
  }

  await withActor(me.id, async (tx) => {
    // Close any currently-open term for this category whose effectiveFrom is
    // strictly before the new one (i.e. the previously-active row).
    const supersededEnd = new Date(effectiveFrom);
    supersededEnd.setUTCDate(supersededEnd.getUTCDate() - 1);

    await tx.agentTerm.updateMany({
      where: {
        agentId,
        fundCategory,
        effectiveTo: null,
        effectiveFrom: { lt: effectiveFrom },
      },
      data: { effectiveTo: supersededEnd },
    });

    // If a row already exists with this exact (agent, category, effectiveFrom),
    // update it instead of inserting a duplicate.
    const existing = await tx.agentTerm.findFirst({
      where: { agentId, fundCategory, effectiveFrom },
    });
    if (existing) {
      await tx.agentTerm.update({
        where: { id: existing.id },
        data: {
          upfrontPct: upfront,
          trailY1PctPa: trailY1,
          trailY2PlusPctPa: trailY2,
          trailFrequency,
          clawbackMonths,
          clawbackPct,
        },
      });
    } else {
      await tx.agentTerm.create({
        data: {
          agentId,
          fundCategory,
          upfrontPct: upfront,
          trailY1PctPa: trailY1,
          trailY2PlusPctPa: trailY2,
          trailFrequency,
          clawbackMonths,
          clawbackPct,
          effectiveFrom,
          createdBy: me.id,
        },
      });
    }
  });

  revalidatePath(`/admin/agents/${agentId}`);
  redirect(`/admin/agents/${agentId}?ok=${encodeURIComponent(`Saved ${fundCategory} term effective ${effectiveFromRaw}`)}`);
}

/**
 * Edit a specific AgentTerm row in place — only the value fields, not the
 * effective dates (use addAgentTerm to introduce a new effective period).
 */
export async function updateAgentTerm(formData: FormData): Promise<void> {
  const me = await requireRole(["admin", "checker"]);
  const id = String(formData.get("id") ?? "").trim();
  const agentId = String(formData.get("agentId") ?? "").trim();
  if (!id || !agentId) return;

  const upfront = parsePct(String(formData.get("upfrontPct") ?? ""));
  const trailY1 = parsePct(String(formData.get("trailY1PctPa") ?? ""));
  const trailY2 = parsePct(String(formData.get("trailY2PlusPctPa") ?? ""));
  const clawbackMonths = Number(formData.get("clawbackMonths") ?? "6") || 6;
  const clawbackPct = parsePct(String(formData.get("clawbackPct") ?? "1"));
  const trailFrequency = parseFrequency(String(formData.get("trailFrequency") ?? "monthly"));

  if (upfront == null || trailY1 == null || trailY2 == null || clawbackPct == null) {
    redirect(`/admin/agents/${agentId}?error=All+percentages+must+be+numbers`);
  }

  await withActor(me.id, (tx) =>
    tx.agentTerm.update({
      where: { id },
      data: {
        upfrontPct: upfront,
        trailY1PctPa: trailY1,
        trailY2PlusPctPa: trailY2,
        trailFrequency,
        clawbackMonths,
        clawbackPct,
      },
    }),
  );
  revalidatePath(`/admin/agents/${agentId}`);
  redirect(`/admin/agents/${agentId}?ok=${encodeURIComponent("Term updated")}`);
}

/**
 * Delete an AgentTerm row outright. Used to clean up data-entry errors
 * — when a term was saved with wrong values (e.g. 20% instead of
 * 0.20%) and superseded by a corrected row, the bad row should go so
 * the commission engine + retroactive calculators don't pick it.
 */
export async function deleteAgentTerm(formData: FormData): Promise<void> {
  const me = await requireRole(["admin", "checker"]);
  const id = String(formData.get("id") ?? "").trim();
  const agentId = String(formData.get("agentId") ?? "").trim();
  if (!id || !agentId) return;

  await withActor(me.id, (tx) => tx.agentTerm.delete({ where: { id } }));
  revalidatePath(`/admin/agents/${agentId}`);
  redirect(`/admin/agents/${agentId}?ok=${encodeURIComponent("Term deleted")}`);
}

/**
 * Link an existing portal investor to an X-System selling agent. Creates
 * an `xsystem.agent_investors` row that the commission engine + agent
 * portal use to identify who the agent sourced.
 */
export async function linkInvestorToAgent(formData: FormData): Promise<void> {
  const me = await requireRole(["admin", "checker"]);
  const agentId = String(formData.get("agentId") ?? "").trim();
  const investorCode = String(formData.get("investorCode") ?? "").trim();
  const fundCode = String(formData.get("fundCode") ?? "").trim();
  const sourcedOnRaw = String(formData.get("sourcedOn") ?? "").trim();
  const initialUnits = Number(formData.get("initialUnits") ?? "0") || 0;
  const initialGrossAmount = Number(formData.get("initialGrossAmount") ?? "0") || 0;
  const unitPriceAtSourcing = Number(formData.get("unitPriceAtSourcing") ?? "0") || 0;
  const isDirectSubscription = formData.get("isDirectSubscription") === "on";

  if (!agentId) redirect(`/admin/agents?error=Missing+agent`);
  if (!investorCode) redirect(`/admin/agents/${agentId}?error=Investor+is+required`);
  if (!["EFUF", "EGF", "ESRF"].includes(fundCode)) {
    redirect(`/admin/agents/${agentId}?error=Fund+must+be+EFUF%2C+EGF+or+ESRF`);
  }
  if (!sourcedOnRaw) redirect(`/admin/agents/${agentId}?error=Sourced-on+date+is+required`);
  if (initialUnits <= 0) redirect(`/admin/agents/${agentId}?error=Initial+units+must+be+positive`);
  if (unitPriceAtSourcing <= 0) redirect(`/admin/agents/${agentId}?error=Unit+price+at+sourcing+must+be+positive`);

  const sourcedOn = new Date(`${sourcedOnRaw}T00:00:00.000Z`);

  try {
    await withActor(me.id, (tx) =>
      tx.agentInvestor.create({
        data: {
          agentId,
          investorCode,
          fundCode,
          sourcedOn,
          initialUnits,
          initialGrossAmount: initialGrossAmount || initialUnits * unitPriceAtSourcing,
          unitPriceAtSourcing,
          isDirectSubscription,
        },
      }),
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "link failed";
    redirect(`/admin/agents/${agentId}?error=${encodeURIComponent(msg)}`);
  }

  revalidatePath(`/admin/agents/${agentId}`);
  redirect(`/admin/agents/${agentId}?ok=${encodeURIComponent(`Linked investor ${investorCode} to agent`)}`);
}

/**
 * Remove an investor link. The investor remains in the portal; only the
 * X-System mapping disappears (and any future commission runs against
 * this link become impossible — historical runs are preserved).
 */
export async function unlinkInvestor(formData: FormData): Promise<void> {
  const me = await requireRole(["admin", "checker"]);
  const id = String(formData.get("id") ?? "").trim();
  const agentId = String(formData.get("agentId") ?? "").trim();
  if (!id || !agentId) return;
  await withActor(me.id, (tx) => tx.agentInvestor.delete({ where: { id } }));
  revalidatePath(`/admin/agents/${agentId}`);
  redirect(`/admin/agents/${agentId}?ok=${encodeURIComponent("Investor unlinked")}`);
}

/**
 * Post the previewed trail lines to xsystem.commission_runs.
 *
 * Thin wrapper over `postTrailFromPreview` — the same function the monthly cron
 * evaluates with, so what the accountant posts matches what the cron reported.
 * Posts every completed period (skipping partials, which the next run picks up
 * once they close) and is idempotent via the
 * (agent_investor_id, type, period_start, period_end) unique index.
 *
 * Upfront is not posted here — that is the watermark model, posted by
 * "Post upfront now" (postAgentUpfront).
 *
 * ACCOUNTANT ONLY. Posting a commission run is the act that creates the
 * obligation, so it belongs to one role and is attributed to one person. Every
 * run in the system before this was written by an unattended cron with a NULL
 * actor; the crons now compute and report but never write.
 */
export async function postAgentCommissions(formData: FormData): Promise<void> {
  const me = await requireRole(["accountant"]);
  const agentId = String(formData.get("agentId") ?? "").trim();
  if (!agentId) return;

  // The page's billing cut-off, carried through so the rows written match the
  // rows the admin was looking at when they clicked. Blank → today.
  const asOfRaw = String(formData.get("asOf") ?? "").trim();
  const asOf = parseAsOf(asOfRaw);
  const back = asOfRaw ? `&asOf=${encodeURIComponent(asOfRaw)}` : "";

  const res = await postTrailFromPreview({ agentId, actorId: me.id, asOf });
  const a = res.perAgent[0];

  revalidatePath(`/admin/agents/${agentId}`);

  if (a?.error) {
    redirect(
      `/admin/agents/${agentId}?error=${encodeURIComponent(`Posting failed: ${a.error}`)}${back}`,
    );
  }

  // Overlaps are refused, never silently inserted — a period that overlaps an
  // already-posted one without matching it exactly would double-pay the agent.
  // Surface it loudly; silence here is how that ships.
  if (res.overlapConflicts > 0) {
    const detail = (a?.overlaps ?? [])
      .slice(0, 3)
      .map((o) => `${o.candidate} overlaps posted ${o.existing}`)
      .join("; ");
    redirect(
      `/admin/agents/${agentId}?error=${encodeURIComponent(
        `Posted ${res.created} row(s), but REFUSED ${res.overlapConflicts} overlapping period(s) — these would double-pay. ${detail}. Check the term's trail frequency against what is already posted.`,
      )}${back}`,
    );
  }

  const bits = [`Posted ${res.created} trail row(s) (BDT ${res.createdAmount.toFixed(2)})`];
  if (res.duplicates) bits.push(`${res.duplicates} already posted`);
  if (res.partialSkipped) bits.push(`${res.partialSkipped} still accruing`);
  if (asOfRaw) bits.push(`as of ${asOfRaw}`);
  redirect(`/admin/agents/${agentId}?ok=${encodeURIComponent(`${bits.join("; ")}.`)}${back}`);
}

/**
 * Post the watermark upfront for one agent "as of today" — evaluates the
 * per-(agent,investor) high-water-mark through today, posts an agent-level
 * upfront CommissionRun on any new-money increment, and ratchets the
 * watermark. Same engine the monthly cron uses; idempotent (re-clicking
 * with no new money posts nothing).
 */
export async function postAgentUpfront(formData: FormData): Promise<void> {
  // ACCOUNTANT ONLY — see postAgentCommissions.
  const me = await requireRole(["accountant"]);
  const agentId = String(formData.get("agentId") ?? "").trim();
  if (!agentId) return;

  // Evaluate through the page's billing cut-off, not the wall clock — billing
  // to 30 Jul on 4 Aug must not sweep in four days of August new money.
  const asOfRaw = String(formData.get("asOf") ?? "").trim();
  const back = asOfRaw ? `&asOf=${encodeURIComponent(asOfRaw)}` : "";
  const cut = parseAsOf(asOfRaw);
  const through = new Date(Date.UTC(cut.getUTCFullYear(), cut.getUTCMonth(), cut.getUTCDate()));
  const monthStart = new Date(Date.UTC(cut.getUTCFullYear(), cut.getUTCMonth(), 1));
  const res = await runUpfront(monthStart, through, through, { agentId, actorId: me.id });

  revalidatePath(`/admin/agents/${agentId}`);
  // "Nothing to post" is only true if the agent was actually evaluated. It used
  // to be reported for unapproved agents too, which meant an accountant looking
  // at a real pending increment was told the money did not exist.
  const msg = res.created > 0
    ? `Posted ${res.created} upfront row(s) · ${res.totalUpfront.toFixed(2)} BDT (watermark ratcheted).`
    : res.notApproved.length > 0
      ? `Not posted — ${res.notApproved[0]}. Approve the agent first.`
      : res.blocked > 0
        ? `Not posted — ${res.blockedDetail[0]?.reason ?? "blocked, see the run warnings"}.`
        : res.suspended > 0
          ? `Not posted — upfront is suspended for this agent.`
          : `No new money above the book watermark — nothing to post.`;
  redirect(`/admin/agents/${agentId}?ok=${encodeURIComponent(msg)}${back}`);
}

function round2BD(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Suspend an agent's upfront entitlement from a date. While suspended the
 *  monthly run pays no upfront (forfeit, no catch-up). */
export async function suspendAgentUpfront(formData: FormData): Promise<void> {
  const me = await requireRole(["admin", "checker", "accountant"]);
  const agentId = String(formData.get("agentId") ?? "").trim();
  const fromRaw = String(formData.get("effectiveFrom") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim() || null;
  if (!agentId) redirect("/admin/agents?error=Missing+agent");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromRaw)) {
    redirect(`/admin/agents/${agentId}?error=Suspend+date+required+(YYYY-MM-DD)`);
  }
  await withActor(me.id, (tx) =>
    tx.agentUpfrontSuspension.create({
      data: { agentId, action: "suspend", effectiveFrom: new Date(`${fromRaw}T00:00:00.000Z`), note, createdBy: me.id },
    }),
  );
  revalidatePath(`/admin/agents/${agentId}`);
  redirect(`/admin/agents/${agentId}?ok=${encodeURIComponent(`Upfront suspended from ${fromRaw}`)}`);
}

/** Re-instate an agent's upfront entitlement from a date. The accountant
 *  should also set the book watermark (setAgentWatermark) so no back-dated
 *  upfront accrues on money that arrived during suspension. One figure now,
 *  not one per investor. */
export async function reinstateAgentUpfront(formData: FormData): Promise<void> {
  const me = await requireRole(["admin", "checker", "accountant"]);
  const agentId = String(formData.get("agentId") ?? "").trim();
  const fromRaw = String(formData.get("effectiveFrom") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim() || null;
  if (!agentId) redirect("/admin/agents?error=Missing+agent");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromRaw)) {
    redirect(`/admin/agents/${agentId}?error=Re-instate+date+required+(YYYY-MM-DD)`);
  }
  await withActor(me.id, (tx) =>
    tx.agentUpfrontSuspension.create({
      data: { agentId, action: "reinstate", effectiveFrom: new Date(`${fromRaw}T00:00:00.000Z`), note, createdBy: me.id },
    }),
  );
  revalidatePath(`/admin/agents/${agentId}`);
  redirect(`/admin/agents/${agentId}?ok=${encodeURIComponent(`Upfront re-instated from ${fromRaw} — review the watermark below`)}`);
}

/** Manually set an agent's BOOK upfront watermark. Used at re-instatement to
 *  baseline the high-water-mark so future upfront pays only on new money above
 *  this value.
 *
 *  One figure per agent since 2026-08. The old per-investor form took an
 *  investorCode and had to guard that the investor was actually linked, since
 *  a watermark against a stranger would have suppressed nobody's upfront while
 *  sitting invisible in the table. There is no such footgun now — there is
 *  exactly one row per agent and the agent id comes from the page, not a
 *  free-form field. */
export async function setAgentWatermark(formData: FormData): Promise<void> {
  const me = await requireRole(["admin", "checker", "accountant"]);
  const agentId = String(formData.get("agentId") ?? "").trim();
  const valueRaw = String(formData.get("watermark") ?? "").trim();
  const value = Number(valueRaw);
  if (!agentId) {
    redirect(`/admin/agents?error=Missing+agent`);
  }
  if (!Number.isFinite(value) || value < 0) {
    redirect(`/admin/agents/${agentId}?error=Watermark+must+be+a+non-negative+number`);
  }

  const prev = await prisma.agentBookWatermark.findUnique({
    where: { agentId },
    select: { watermark: true },
  });
  const today = new Date();
  await withActor(me.id, (tx) =>
    tx.agentBookWatermark.upsert({
      where: { agentId },
      create: { agentId, watermark: round2BD(value), throughDate: today },
      update: { watermark: round2BD(value), throughDate: today },
    }),
  );
  revalidatePath(`/admin/agents/${agentId}`);
  const prevStr = prev ? ` (was ${round2BD(Number(prev.watermark))})` : "";
  redirect(
    `/admin/agents/${agentId}?ok=${encodeURIComponent(`Book watermark set to ${round2BD(value)}${prevStr} — applies across every investor and all funds.`)}`,
  );
}

// ─── Commission payout: accrue → pay ──────────────────────────────────
// Thin form wrappers over src/lib/commission-payout.ts. The engine throws
// PayoutError with a message written for the accountant, so the only job here
// is to unwrap the form, call it, and put the message back on the page.

/** Paths whose numbers move when a commission voucher is posted. Same set the
 *  tax-provision action revalidates — a payable that shows on the balance sheet
 *  but not in the day book is how an accountant loses trust in the system. */
const STATEMENT_PATHS = [
  "/balance-sheet",
  "/income-statement",
  "/trial-balance",
  "/day-book",
  "/journals",
];

function payoutBack(agentId: string, asOfRaw: string, key: "ok" | "error", msg: string): never {
  const back = asOfRaw ? `&asOf=${encodeURIComponent(asOfRaw)}` : "";
  redirect(`/admin/agents/${agentId}?${key}=${encodeURIComponent(msg)}${back}`);
}

/**
 * Step 1 — post the accrual voucher, dated the billing period end.
 * Dr Selling agent fees / Cr Liab-Selling Agent Commission.
 */
export async function accrueAgentCommissionAction(formData: FormData): Promise<void> {
  const me = await requireRole(["admin", "checker", "accountant"]);
  const agentId = String(formData.get("agentId") ?? "").trim();
  if (!agentId) redirect("/admin/agents?error=Missing+agent");

  const billingRaw = String(formData.get("billingEnd") ?? "").trim();
  const asOfRaw = String(formData.get("asOf") ?? "").trim();
  const billingEnd = parseDateOnly(billingRaw);
  if (!billingEnd) {
    payoutBack(agentId, asOfRaw, "error", "Billing period end is required (YYYY-MM-DD).");
  }

  let res;
  try {
    res = await accrueAgentCommission({ agentId, billingEnd, actorId: me.id });
  } catch (err) {
    if (err instanceof PayoutError) payoutBack(agentId, asOfRaw, "error", err.message);
    throw err;
  }

  revalidatePath(`/admin/agents/${agentId}`);
  for (const p of STATEMENT_PATHS) revalidatePath(p);

  if (res.noop) {
    payoutBack(
      agentId,
      asOfRaw,
      "ok",
      `Nothing to accrue up to ${billingRaw} — every commission run in that period is already on the ledger. Post upfront/trail first if the period is not computed yet.`,
    );
  }
  payoutBack(
    agentId,
    asOfRaw,
    "ok",
    `Accrued BDT ${res.amount.toFixed(2)} (${describeSplit(res.byType)}) across ${res.runs} run(s) — voucher ${res.voucherNo} dated ${res.periodEnd}. One voucher covers upfront and trail together: Dr Selling agent fees / Cr Liab-Selling Agent Commission.`,
  );
}

/**
 * Step 2 — post the payment voucher, dated the day the transfer left.
 * Dr the payable / Cr bank (net) / Cr AIT & VAT Payble (withheld).
 */
export async function payAgentCommissionAction(formData: FormData): Promise<void> {
  const me = await requireRole(["admin", "checker", "accountant"]);
  const agentId = String(formData.get("agentId") ?? "").trim();
  if (!agentId) redirect("/admin/agents?error=Missing+agent");

  const asOfRaw = String(formData.get("asOf") ?? "").trim();
  const billingRaw = String(formData.get("billingEnd") ?? "").trim();
  const paidRaw = String(formData.get("paidOn") ?? "").trim();
  const bankAccountName = String(formData.get("bankAccountName") ?? "").trim();
  const whtRaw = String(formData.get("withholdingPct") ?? "").trim();

  const billingEnd = parseDateOnly(billingRaw);
  const paidOn = parseDateOnly(paidRaw);
  if (!billingEnd) {
    payoutBack(agentId, asOfRaw, "error", "Billing period end is required (YYYY-MM-DD).");
  }
  if (!paidOn) {
    payoutBack(agentId, asOfRaw, "error", "Payment date is required (YYYY-MM-DD).");
  }
  if (!bankAccountName) {
    payoutBack(agentId, asOfRaw, "error", "Pick the bank account the transfer left from.");
  }
  // Entered as a percentage (10 = 10%); the engine works in fractions.
  const whtPct = whtRaw === "" ? 0 : Number(whtRaw);
  if (!Number.isFinite(whtPct) || whtPct < 0 || whtPct >= 100) {
    payoutBack(agentId, asOfRaw, "error", "Withholding must be a percentage between 0 and 100.");
  }

  let res;
  try {
    res = await payAgentCommission({
      agentId,
      billingEnd,
      paidOn,
      bankAccountName,
      withholdingPct: whtPct / 100,
      actorId: me.id,
    });
  } catch (err) {
    if (err instanceof PayoutError) payoutBack(agentId, asOfRaw, "error", err.message);
    throw err;
  }

  revalidatePath(`/admin/agents/${agentId}`);
  for (const p of STATEMENT_PATHS) revalidatePath(p);

  if (res.noop) {
    payoutBack(
      agentId,
      asOfRaw,
      "ok",
      `Nothing accrued-and-unpaid up to ${billingRaw} — either it is already paid, or the accrual voucher has not been posted yet (step 1).`,
    );
  }
  payoutBack(
    agentId,
    asOfRaw,
    "ok",
    `Paid BDT ${res.net.toFixed(2)} net (gross ${res.gross.toFixed(2)} − withholding ${res.withholding.toFixed(2)}) from ${bankAccountName} on ${paidRaw} — voucher ${res.voucherNo}, ${res.runs} run(s) settled.`,
  );
}

export async function createAgent(formData: FormData): Promise<void> {
  await requireRole(["admin", "checker"]);
  const code = String(formData.get("code") ?? "").trim();
  const fullName = String(formData.get("fullName") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const phone = String(formData.get("phone") ?? "").trim() || null;

  if (!code || !fullName || !email) {
    backToInvite("Agent code, full name and email are all required.");
  }

  let created;
  try {
    created = await prisma.sellingAgent.create({
      data: { code, fullName, email, phone, status: "pending" },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      // Unique violation. `meta.target` tells which column collided.
      const target = (err.meta?.target as string[] | undefined) ?? [];
      const field = target[0] ?? "field";
      const friendlyField =
        field === "email" ? "email" : field === "code" ? "agent code" : field;
      const existingValue = field === "email" ? email : field === "code" ? code : "";
      backToInvite(
        `An agent with this ${friendlyField}${existingValue ? ` (${existingValue})` : ""} already exists. Pick a different ${friendlyField}, or open the existing record from /admin/agents.`,
      );
    }
    throw err;
  }
  revalidatePath("/admin/agents");
  redirect(`/admin/agents/${created.id}`);
}

/**
 * Reverse one commission run — the restatement path.
 *
 * Needed because unlinking an investor deliberately preserves historical runs
 * (see unlinkInvestor), so a run posted in error had no way back short of
 * editing the database. `reversed` was already excluded by every reader; this
 * is what finally writes it.
 *
 * Refused for a `paid` run: the money has left, so that is a refund, not a
 * restatement. See reverseCommissionRun for the accounting.
 */
export async function reverseCommissionRunAction(formData: FormData): Promise<void> {
  const me = await requireRole(["admin", "checker", "accountant"]);
  const agentId = String(formData.get("agentId") ?? "").trim();
  if (!agentId) redirect("/admin/agents?error=Missing+agent");

  const runId = String(formData.get("runId") ?? "").trim();
  const asOfRaw = String(formData.get("asOf") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim();

  if (!runId) payoutBack(agentId, asOfRaw, "error", "Missing commission run.");
  if (!reason) {
    payoutBack(
      agentId,
      asOfRaw,
      "error",
      "A reason is required to reverse a commission run — it is what the audit trail shows later.",
    );
  }

  // Optional override for the contra voucher's date. Left blank the reversal
  // is dated the run's own period end, which is where the correction belongs;
  // it is only needed when that fiscal year has since been closed.
  const onRaw = String(formData.get("on") ?? "").trim();
  const on = onRaw ? parseDateOnly(onRaw) : undefined;
  if (onRaw && !on) {
    payoutBack(agentId, asOfRaw, "error", "Reversal date must be YYYY-MM-DD.");
  }

  let res;
  try {
    res = await reverseCommissionRun({ runId, reason, on: on ?? undefined, actorId: me.id });
  } catch (err) {
    if (err instanceof PayoutError) payoutBack(agentId, asOfRaw, "error", err.message);
    throw err;
  }

  revalidatePath(`/admin/agents/${agentId}`);
  for (const p of STATEMENT_PATHS) revalidatePath(p);

  payoutBack(
    agentId,
    asOfRaw,
    "ok",
    res.journalOnly
      ? `Reversed ${res.type} of BDT ${res.amount.toFixed(2)} — contra voucher ${res.voucherNo} posted (Dr Liab-Selling Agent Commission / Cr Selling agent fees). The run stays on record as reversed.`
      : `Reversed ${res.type} of BDT ${res.amount.toFixed(2)}. It had not been accrued to the ledger, so no voucher was needed — it simply drops out of the next accrual.`,
  );
}
