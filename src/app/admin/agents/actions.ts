"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireRole } from "@/lib/auth";

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
  await prisma.$transaction([
    prisma.sellingAgent.update({
      where: { id },
      data: { status: "approved", approvedAt: today, approvedBy: me.id },
    }),
    prisma.agentTerm.create({
      data: {
        agentId: id,
        fundCategory: "equity",
        ...DEFAULT_TERM_EQUITY,
        effectiveFrom: today,
        createdBy: me.id,
      },
    }),
    prisma.agentTerm.create({
      data: {
        agentId: id,
        fundCategory: "fixed_income",
        ...DEFAULT_TERM_FIXED_INCOME,
        effectiveFrom: today,
        createdBy: me.id,
      },
    }),
  ]);
  revalidatePath("/admin/agents");
  revalidatePath(`/admin/agents/${id}`);
}

export async function suspendAgent(id: string): Promise<void> {
  await requireRole(["admin"]);
  await prisma.sellingAgent.update({ where: { id }, data: { status: "suspended" } });
  revalidatePath("/admin/agents");
  revalidatePath(`/admin/agents/${id}`);
}

export async function reinstateAgent(id: string): Promise<void> {
  await requireRole(["admin"]);
  await prisma.sellingAgent.update({ where: { id }, data: { status: "approved" } });
  revalidatePath("/admin/agents");
  revalidatePath(`/admin/agents/${id}`);
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
