"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { Prisma } from "@/generated/prisma";
import { prisma, withActor } from "@/lib/prisma";
import { requireRole } from "@/lib/auth";
import { computeAgentCommissionPreview } from "@/lib/agent-commission-preview";

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

export async function approveAgent(id: string): Promise<void> {
  const me = await requireRole(["admin", "checker"]);
  const today = new Date();
  await withActor(me.id, async (tx) => {
    await tx.sellingAgent.update({
      where: { id },
      data: { status: "approved", approvedAt: today, approvedBy: me.id },
    });
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
  });
  revalidatePath("/admin/agents");
  revalidatePath(`/admin/agents/${id}`);
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
  let createdUpfront = 0;
  let createdTrail = 0;
  let skipped = 0;

  await withActor(me.id, async (tx) => {
    for (const b of preview.buckets) {
      if (b.isDirectSubscription) continue;
      if (b.initialUpfront <= 0) continue;
      const term = preview.termsActive.find((t) => t.fundCategory === b.category);
      if (!term) continue;
      const initialGross = round2BD(
        // Reconstruct base = initialUpfront / rate so the BS-friendly
        // base_amount lines up with the rate_applied column.
        term.upfrontPct > 0 ? b.initialUpfront / term.upfrontPct : 0,
      );
      try {
        await tx.commissionRun.create({
          data: {
            agentId,
            agentInvestorId: b.agentInvestorId,
            type: "upfront",
            periodStart: null,
            periodEnd: b.sourcedOn,
            baseAmount: initialGross,
            rateApplied: term.upfrontPct,
            amount: b.initialUpfront,
            notes: `Posted from /admin/agents preview on ${today.toISOString().slice(0, 10)}`,
          },
        });
        createdUpfront++;
      } catch (err) {
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === "P2002"
        ) {
          skipped++;
        } else throw err;
      }
    }
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
  const msg = `Posted ${createdUpfront} upfront + ${createdTrail} trail row(s)${skipped ? `; ${skipped} skipped as duplicates` : ""}.`;
  redirect(`/admin/agents/${agentId}?ok=${encodeURIComponent(msg)}`);
}

function round2BD(n: number): number {
  return Math.round(n * 100) / 100;
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
