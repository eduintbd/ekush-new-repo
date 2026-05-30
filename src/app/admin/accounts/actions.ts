"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma, withActor } from "@/lib/prisma";
import { requireRole } from "@/lib/auth";

const NORMAL_BALANCE = new Set(["DEBIT", "CREDIT"]);

function back(error: string): never {
  redirect(`/admin/accounts/new?error=${encodeURIComponent(error)}`);
}

function backTo(id: string, error: string): never {
  redirect(`/admin/accounts/${id}?error=${encodeURIComponent(error)}`);
}

export async function createAccount(formData: FormData): Promise<void> {
  const me = await requireRole(["admin", "checker"]);

  const name = String(formData.get("name") ?? "").trim();
  const normalBalance = String(formData.get("normalBalance") ?? "").trim().toUpperCase();
  const category = String(formData.get("category") ?? "").trim() || null;
  const groupId = String(formData.get("groupId") ?? "").trim() || null;
  const slRaw = String(formData.get("sl") ?? "").trim();

  if (!name) back("Account name is required.");
  if (!NORMAL_BALANCE.has(normalBalance)) back("Normal balance must be DEBIT or CREDIT.");

  let sl: number;
  if (slRaw) {
    const n = Number(slRaw);
    if (!Number.isInteger(n) || n <= 0) back("Sl must be a positive integer.");
    sl = n;
  } else {
    const max = await prisma.chartOfAccount.aggregate({ _max: { sl: true } });
    sl = (max._max.sl ?? 0) + 1;
  }

  try {
    await withActor(me.id, (tx) =>
      tx.chartOfAccount.create({
        data: { name, sl, normalBalance, category, groupId },
      }),
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to create account.";
    if (msg.includes("Unique constraint") || msg.includes("unique")) {
      back(`An account named "${name}" already exists.`);
    }
    back(msg);
  }

  revalidatePath("/admin/accounts");
  redirect(`/admin/accounts?ok=${encodeURIComponent(`Created "${name}"`)}`);
}

export async function updateAccount(formData: FormData): Promise<void> {
  const me = await requireRole(["admin", "checker"]);
  const id = String(formData.get("id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const normalBalance = String(formData.get("normalBalance") ?? "").trim().toUpperCase();
  const category = String(formData.get("category") ?? "").trim() || null;
  const groupId = String(formData.get("groupId") ?? "").trim() || null;
  const slRaw = String(formData.get("sl") ?? "").trim();

  if (!id) redirect("/admin/accounts?error=Missing+id");
  if (!name) backTo(id, "Account name is required.");
  if (!NORMAL_BALANCE.has(normalBalance)) backTo(id, "Normal balance must be DEBIT or CREDIT.");
  const sl = Number(slRaw);
  if (!Number.isInteger(sl) || sl <= 0) backTo(id, "Sl must be a positive integer.");

  try {
    await withActor(me.id, (tx) =>
      tx.chartOfAccount.update({
        where: { id },
        data: { name, sl, normalBalance, category, groupId },
      }),
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to update account.";
    backTo(id, msg);
  }

  revalidatePath("/admin/accounts");
  revalidatePath(`/admin/accounts/${id}`);
  redirect(`/admin/accounts?ok=${encodeURIComponent(`Updated "${name}"`)}`);
}

export async function toggleAccountActive(formData: FormData): Promise<void> {
  const me = await requireRole(["admin", "checker"]);
  const id = String(formData.get("id") ?? "");
  if (!id) redirect("/admin/accounts?error=Missing+id");

  const current = await prisma.chartOfAccount.findUnique({ where: { id } });
  if (!current) redirect("/admin/accounts?error=Account+not+found");

  await withActor(me.id, (tx) =>
    tx.chartOfAccount.update({ where: { id }, data: { isActive: !current!.isActive } }),
  );

  revalidatePath("/admin/accounts");
  revalidatePath(`/admin/accounts/${id}`);
  redirect(
    `/admin/accounts?ok=${encodeURIComponent(
      current!.isActive ? `Deactivated "${current!.name}"` : `Reactivated "${current!.name}"`,
    )}`,
  );
}
