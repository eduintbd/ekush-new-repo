"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { withActor } from "@/lib/prisma";
import { requireRole } from "@/lib/auth";

export async function createCostCentre(formData: FormData): Promise<void> {
  const me = await requireRole(["admin"]);
  const code = String(formData.get("code") ?? "").trim().toUpperCase();
  const name = String(formData.get("name") ?? "").trim();
  const parentId = String(formData.get("parentId") ?? "").trim() || null;
  const description = String(formData.get("description") ?? "").trim() || null;

  if (!code) redirect(`/admin/cost-centres?error=Code+is+required`);
  if (!name) redirect(`/admin/cost-centres?error=Name+is+required`);

  try {
    await withActor(me.id, (tx) =>
      tx.costCentre.create({ data: { code, name, parentId, description } }),
    );
  } catch (e) {
    redirect(`/admin/cost-centres?error=${encodeURIComponent(e instanceof Error ? e.message : "create failed")}`);
  }
  revalidatePath("/admin/cost-centres");
  revalidatePath("/journals/new");
  redirect(`/admin/cost-centres?ok=${encodeURIComponent(`Created ${code}`)}`);
}

export async function updateCostCentre(formData: FormData): Promise<void> {
  const me = await requireRole(["admin"]);
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return;
  const code = String(formData.get("code") ?? "").trim().toUpperCase();
  const name = String(formData.get("name") ?? "").trim();
  const parentId = String(formData.get("parentId") ?? "").trim() || null;
  const description = String(formData.get("description") ?? "").trim() || null;
  const isActive = formData.get("isActive") === "on";

  if (parentId === id) redirect(`/admin/cost-centres?error=A+cost+centre+cannot+be+its+own+parent`);

  await withActor(me.id, (tx) =>
    tx.costCentre.update({ where: { id }, data: { code, name, parentId, description, isActive } }),
  );
  revalidatePath("/admin/cost-centres");
  revalidatePath("/journals/new");
  redirect(`/admin/cost-centres?ok=${encodeURIComponent("Updated")}`);
}

export async function deleteCostCentre(formData: FormData): Promise<void> {
  const me = await requireRole(["admin"]);
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return;
  await withActor(me.id, (tx) => tx.costCentre.delete({ where: { id } }));
  revalidatePath("/admin/cost-centres");
  revalidatePath("/journals/new");
  redirect(`/admin/cost-centres?ok=${encodeURIComponent("Deleted")}`);
}
