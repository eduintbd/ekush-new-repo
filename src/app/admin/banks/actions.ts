"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { withActor } from "@/lib/prisma";
import { requireRole } from "@/lib/auth";

const TYPES = ["current", "savings", "std", "md", "fdr", "mobile_money", "other"] as const;

export async function createBankAccount(formData: FormData): Promise<void> {
  const me = await requireRole(["admin", "checker"]);
  const accountName = String(formData.get("accountName") ?? "").trim();
  const bankName = String(formData.get("bankName") ?? "").trim();
  const branch = String(formData.get("branch") ?? "").trim() || null;
  const accountNumber = String(formData.get("accountNumber") ?? "").trim();
  const accountType = String(formData.get("accountType") ?? "current") as (typeof TYPES)[number];
  const currency = String(formData.get("currency") ?? "BDT").trim() || "BDT";
  const ifsc = String(formData.get("ifsc") ?? "").trim() || null;
  const swift = String(formData.get("swift") ?? "").trim() || null;
  const openingBalance = Number(formData.get("openingBalance") ?? "0") || 0;
  const reconciliationStartRaw = String(formData.get("reconciliationStart") ?? "").trim();
  const notes = String(formData.get("notes") ?? "").trim() || null;

  if (!accountName) redirect(`/admin/banks?error=Account+is+required`);
  if (!bankName) redirect(`/admin/banks?error=Bank+name+is+required`);
  if (!accountNumber) redirect(`/admin/banks?error=Account+number+is+required`);
  if (!TYPES.includes(accountType)) redirect(`/admin/banks?error=Invalid+account+type`);

  try {
    await withActor(me.id, (tx) =>
      tx.bankAccount.create({
        data: {
          accountName,
          bankName,
          branch,
          accountNumber,
          accountType,
          currency,
          ifsc,
          swift,
          openingBalance,
          reconciliationStart: reconciliationStartRaw ? new Date(reconciliationStartRaw) : null,
          notes,
        },
      }),
    );
  } catch (e) {
    redirect(`/admin/banks?error=${encodeURIComponent(e instanceof Error ? e.message : "create failed")}`);
  }
  revalidatePath("/admin/banks");
  redirect(`/admin/banks?ok=${encodeURIComponent(`Created bank record for ${accountName}`)}`);
}

export async function updateBankAccount(formData: FormData): Promise<void> {
  const me = await requireRole(["admin", "checker"]);
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return;

  const bankName = String(formData.get("bankName") ?? "").trim();
  const branch = String(formData.get("branch") ?? "").trim() || null;
  const accountNumber = String(formData.get("accountNumber") ?? "").trim();
  const accountType = String(formData.get("accountType") ?? "current") as (typeof TYPES)[number];
  const currency = String(formData.get("currency") ?? "BDT").trim() || "BDT";
  const ifsc = String(formData.get("ifsc") ?? "").trim() || null;
  const swift = String(formData.get("swift") ?? "").trim() || null;
  const openingBalance = Number(formData.get("openingBalance") ?? "0") || 0;
  const reconciliationStartRaw = String(formData.get("reconciliationStart") ?? "").trim();
  const notes = String(formData.get("notes") ?? "").trim() || null;
  const isActive = formData.get("isActive") === "on";

  await withActor(me.id, (tx) =>
    tx.bankAccount.update({
      where: { id },
      data: {
        bankName,
        branch,
        accountNumber,
        accountType,
        currency,
        ifsc,
        swift,
        openingBalance,
        reconciliationStart: reconciliationStartRaw ? new Date(reconciliationStartRaw) : null,
        notes,
        isActive,
      },
    }),
  );
  revalidatePath("/admin/banks");
  redirect(`/admin/banks?ok=${encodeURIComponent("Updated")}`);
}

export async function deleteBankAccount(formData: FormData): Promise<void> {
  const me = await requireRole(["admin", "checker"]);
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return;
  await withActor(me.id, (tx) => tx.bankAccount.delete({ where: { id } }));
  revalidatePath("/admin/banks");
  redirect(`/admin/banks?ok=${encodeURIComponent("Removed")}`);
}
