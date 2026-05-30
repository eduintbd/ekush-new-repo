"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma, withActor } from "@/lib/prisma";
import { requireRole } from "@/lib/auth";

const NATURES = ["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"] as const;

export async function createGroup(formData: FormData): Promise<void> {
  const me = await requireRole(["admin", "checker"]);
  const name = String(formData.get("name") ?? "").trim();
  const nature = String(formData.get("nature") ?? "").trim() as (typeof NATURES)[number];
  const parentId = String(formData.get("parentId") ?? "").trim() || null;
  const sortOrder = Number(formData.get("sortOrder") ?? "0") || 0;
  const description = String(formData.get("description") ?? "").trim() || null;

  if (!name) redirect(`/admin/groups?error=Name+is+required`);
  if (!NATURES.includes(nature)) redirect(`/admin/groups?error=Invalid+nature`);

  try {
    await withActor(me.id, (tx) =>
      tx.accountGroup.create({
        data: { name, parentId, nature, sortOrder, description, isReserved: false },
      }),
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "create failed";
    redirect(`/admin/groups?error=${encodeURIComponent(msg)}`);
  }

  revalidatePath("/admin/groups");
  redirect(`/admin/groups?ok=${encodeURIComponent(`Created "${name}"`)}`);
}

export async function updateGroup(formData: FormData): Promise<void> {
  const me = await requireRole(["admin", "checker"]);
  const id = String(formData.get("id") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const nature = String(formData.get("nature") ?? "").trim() as (typeof NATURES)[number];
  const parentId = String(formData.get("parentId") ?? "").trim() || null;
  const sortOrder = Number(formData.get("sortOrder") ?? "0") || 0;
  const description = String(formData.get("description") ?? "").trim() || null;

  if (!id) return;
  if (!name) redirect(`/admin/groups?error=Name+is+required`);
  if (!NATURES.includes(nature)) redirect(`/admin/groups?error=Invalid+nature`);
  if (parentId === id) redirect(`/admin/groups?error=A+group+cannot+be+its+own+parent`);

  try {
    await withActor(me.id, (tx) =>
      tx.accountGroup.update({
        where: { id },
        data: { name, parentId, nature, sortOrder, description },
      }),
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "update failed";
    redirect(`/admin/groups?error=${encodeURIComponent(msg)}`);
  }
  revalidatePath("/admin/groups");
  redirect(`/admin/groups?ok=${encodeURIComponent(`Updated "${name}"`)}`);
}

export async function deleteGroup(formData: FormData): Promise<void> {
  const me = await requireRole(["admin", "checker"]);
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return;

  const group = await prisma.accountGroup.findUnique({
    where: { id },
    include: { _count: { select: { accounts: true, children: true } } },
  });
  if (!group) return;
  if (group._count.accounts > 0) {
    redirect(`/admin/groups?error=${encodeURIComponent(`"${group.name}" has ${group._count.accounts} account(s); reassign first`)}`);
  }
  if (group._count.children > 0) {
    redirect(`/admin/groups?error=${encodeURIComponent(`"${group.name}" has ${group._count.children} child group(s); delete or move first`)}`);
  }

  await withActor(me.id, (tx) => tx.accountGroup.delete({ where: { id } }));
  revalidatePath("/admin/groups");
  redirect(`/admin/groups?ok=${encodeURIComponent(`Deleted "${group.name}"`)}`);
}
