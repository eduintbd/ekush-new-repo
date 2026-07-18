"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { Prisma, UserRole } from "@/generated/prisma";
import { prisma, withActor } from "@/lib/prisma";
import { requireRole } from "@/lib/auth";
import { computeAgentCommissionPreview } from "@/lib/agent-commission-preview";
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
    : `Approved, but the email failed to send (${invite.error ?? "unknown error"}). Use "Resend invite".`;
  redirect(`/admin/agents/${id}?ok=${encodeURIComponent(`Agent approved. ${emailNote}`)}`);
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
      update: {},
    });
    if (!agent!.userId) {
      await tx.sellingAgent.update({ where: { id }, data: { userId: invite.userId! } });
    }
  });

  revalidatePath(`/admin/agents/${id}`);
  const note = invite.emailSent
    ? `Set-password link re-sent to ${agent!.email}.`
    : `Link created but the email failed (${invite.error ?? "unknown error"}).`;
  redirect(`/admin/agents/${id}?${invite.emailSent ? "ok" : "error"}=${encodeURIComponent(note)}`);
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
  await withActor(me.id, (tx) =>
    tx.sellingAgent.update({ where: { id }, data: { status: "suspended" } }),
  );
  revalidatePath("/admin/agents");
  revalidatePath(`/admin/agents/${id}`);
}

export async function reinstateAgent(id: string): Promise<void> {
  const me = await requireRole(["admin", "checker"]);
  await withActor(me.id, (tx) =>
    tx.sellingAgent.update({ where: { id }, data: { status: "approved" } }),
  );
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
 * Post the previewed commission lines to xsystem.commission_runs.
 *
 * Writes one `upfront` row per (investor, fund) bucket using the
 * per-spec initial-only amount (the engine's interpretation: upfront ×
 * initial sourcing gross). Writes one `trail` row per completed
 * quarter from the preview (skips partial quarters where periodEnd >=
 * today, since the cron will pick those up at quarter close).
 *
 * Idempotency comes from the (agent_investor_id, type, period_start,
 * period_end) unique index on commission_runs — re-clicking Post will
 * fail-silently on duplicates and only insert new rows.
 */
export async function postAgentCommissions(formData: FormData): Promise<void> {
  const me = await requireRole(["admin", "checker"]);
  const agentId = String(formData.get("agentId") ?? "").trim();
  if (!agentId) return;

  const preview = await computeAgentCommissionPreview(prisma, agentId);
  const today = new Date();
  let createdTrail = 0;
  let skipped = 0;

  // Upfront is no longer posted here — it's the per-(agent,fund) watermark
  // model, posted by the monthly cron or the "Post upfront now" button
  // (postAgentUpfront). This action posts trail only.
  await withActor(me.id, async (tx) => {
    for (const r of preview.trailRows) {
      if (r.partial) continue; // wait for quarter close
      try {
        await tx.commissionRun.create({
          data: {
            agentId,
            agentInvestorId: r.agentInvestorId,
            type: "trail",
            periodStart: r.quarterStart,
            periodEnd: r.quarterEnd,
            baseAmount: round2BD(r.avgValue),
            rateApplied: r.rateQuarter,
            amount: r.trail,
            notes: `${r.navPoints} NAV pts · ${r.tier} tier · posted from preview ${today.toISOString().slice(0, 10)}`,
          },
        });
        createdTrail++;
      } catch (err) {
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === "P2002"
        ) {
          skipped++;
        } else throw err;
      }
    }
  });

  revalidatePath(`/admin/agents/${agentId}`);
  const msg = `Posted ${createdTrail} trail row(s)${skipped ? `; ${skipped} skipped as duplicates` : ""}.`;
  redirect(`/admin/agents/${agentId}?ok=${encodeURIComponent(msg)}`);
}

/**
 * Post the watermark upfront for one agent "as of today" — evaluates the
 * per-(agent,fund) high-water-mark through today, posts an agent-level
 * upfront CommissionRun on any new-money increment, and ratchets the
 * watermark. Same engine the monthly cron uses; idempotent (re-clicking
 * with no new money posts nothing).
 */
export async function postAgentUpfront(formData: FormData): Promise<void> {
  const me = await requireRole(["admin", "checker"]);
  const agentId = String(formData.get("agentId") ?? "").trim();
  if (!agentId) return;

  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const through = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const res = await runUpfront(monthStart, through, through, { agentId });

  revalidatePath(`/admin/agents/${agentId}`);
  const msg = res.created > 0
    ? `Posted ${res.created} upfront row(s) · ${res.totalUpfront.toFixed(2)} BDT (watermark ratcheted).`
    : `No new money above the watermark — nothing to post.`;
  redirect(`/admin/agents/${agentId}?ok=${encodeURIComponent(msg)}`);
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
 *  should also set each fund's watermark (setAgentWatermark) so no back-dated
 *  upfront accrues on money that arrived during suspension. */
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

/** Manually set a (agent, fund) upfront watermark. Used at re-instatement to
 *  baseline the high-water-mark so future upfront pays only on new money
 *  above this value. */
export async function setAgentWatermark(formData: FormData): Promise<void> {
  const me = await requireRole(["admin", "checker", "accountant"]);
  const agentId = String(formData.get("agentId") ?? "").trim();
  const fundCode = String(formData.get("fundCode") ?? "").trim();
  const valueRaw = String(formData.get("watermark") ?? "").trim();
  const value = Number(valueRaw);
  if (!agentId || !fundCode) redirect(`/admin/agents/${agentId}?error=Missing+agent+or+fund`);
  if (!Number.isFinite(value) || value < 0) {
    redirect(`/admin/agents/${agentId}?error=Watermark+must+be+a+non-negative+number`);
  }
  const today = new Date();
  await withActor(me.id, (tx) =>
    tx.agentUpfrontWatermark.upsert({
      where: { agentId_fundCode: { agentId, fundCode } },
      create: { agentId, fundCode, watermark: round2BD(value), throughDate: today },
      update: { watermark: round2BD(value), throughDate: today },
    }),
  );
  revalidatePath(`/admin/agents/${agentId}`);
  redirect(`/admin/agents/${agentId}?ok=${encodeURIComponent(`${fundCode} watermark set to ${round2BD(value)}`)}`);
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
