"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma, withActor } from "@/lib/prisma";
import { requireRole } from "@/lib/auth";

const FUND_CATEGORIES = ["equity", "fixed_income"] as const;
type FundCategoryT = (typeof FUND_CATEGORIES)[number];

function parsePct(raw: string): number | null {
  const v = Number(raw);
  if (!Number.isFinite(v)) return null;
  // Accept either "0.0020" (decimal) or "0.20" (percent literal). Heuristic:
  // anything ≥ 1 we treat as % and divide by 100. Anything < 1 stays as-is.
  return v >= 1 ? v / 100 : v;
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
  const me = await requireRole(["admin"]);
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
        effectiveFrom: today,
        createdBy: me.id,
      },
    });
    await tx.agentTerm.create({
      data: {
        agentId: id,
        fundCategory: "fixed_income",
        ...DEFAULT_TERM_FIXED_INCOME,
        effectiveFrom: today,
        createdBy: me.id,
      },
    });
  });
  revalidatePath("/admin/agents");
  revalidatePath(`/admin/agents/${id}`);
}

export async function suspendAgent(id: string): Promise<void> {
  const me = await requireRole(["admin"]);
  await withActor(me.id, (tx) =>
    tx.sellingAgent.update({ where: { id }, data: { status: "suspended" } }),
  );
  revalidatePath("/admin/agents");
  revalidatePath(`/admin/agents/${id}`);
}

export async function reinstateAgent(id: string): Promise<void> {
  const me = await requireRole(["admin"]);
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
  const me = await requireRole(["admin"]);
  const agentId = String(formData.get("agentId") ?? "").trim();
  const fundCategory = String(formData.get("fundCategory") ?? "").trim() as FundCategoryT;
  const upfront = parsePct(String(formData.get("upfrontPct") ?? ""));
  const trailY1 = parsePct(String(formData.get("trailY1PctPa") ?? ""));
  const trailY2 = parsePct(String(formData.get("trailY2PlusPctPa") ?? ""));
  const clawbackMonths = Number(formData.get("clawbackMonths") ?? "6") || 6;
  const clawbackPct = parsePct(String(formData.get("clawbackPct") ?? "1"));
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
  const me = await requireRole(["admin"]);
  const id = String(formData.get("id") ?? "").trim();
  const agentId = String(formData.get("agentId") ?? "").trim();
  if (!id || !agentId) return;

  const upfront = parsePct(String(formData.get("upfrontPct") ?? ""));
  const trailY1 = parsePct(String(formData.get("trailY1PctPa") ?? ""));
  const trailY2 = parsePct(String(formData.get("trailY2PlusPctPa") ?? ""));
  const clawbackMonths = Number(formData.get("clawbackMonths") ?? "6") || 6;
  const clawbackPct = parsePct(String(formData.get("clawbackPct") ?? "1"));

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
        clawbackMonths,
        clawbackPct,
      },
    }),
  );
  revalidatePath(`/admin/agents/${agentId}`);
  redirect(`/admin/agents/${agentId}?ok=${encodeURIComponent("Term updated")}`);
}

/**
 * Link an existing portal investor to an X-System selling agent. Creates
 * an `xsystem.agent_investors` row that the commission engine + agent
 * portal use to identify who the agent sourced.
 */
export async function linkInvestorToAgent(formData: FormData): Promise<void> {
  const me = await requireRole(["admin"]);
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
  const me = await requireRole(["admin"]);
  const id = String(formData.get("id") ?? "").trim();
  const agentId = String(formData.get("agentId") ?? "").trim();
  if (!id || !agentId) return;
  await withActor(me.id, (tx) => tx.agentInvestor.delete({ where: { id } }));
  revalidatePath(`/admin/agents/${agentId}`);
  redirect(`/admin/agents/${agentId}?ok=${encodeURIComponent("Investor unlinked")}`);
}

export async function createAgent(formData: FormData): Promise<void> {
  await requireRole(["admin"]);
  const code = String(formData.get("code") ?? "").trim();
  const fullName = String(formData.get("fullName") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const phone = String(formData.get("phone") ?? "").trim() || null;

  if (!code || !fullName || !email) {
    throw new Error("code, fullName, email required");
  }

  const created = await prisma.sellingAgent.create({
    data: { code, fullName, email, phone, status: "pending" },
  });
  redirect(`/admin/agents/${created.id}`);
}
