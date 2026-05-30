"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { withActor } from "@/lib/prisma";
import { requireRole } from "@/lib/auth";

export async function upsertOpeningBalance(formData: FormData): Promise<void> {
  const me = await requireRole(["admin", "checker"]);
  const fiscalYearId = String(formData.get("fiscalYearId") ?? "").trim();
  const accountName = String(formData.get("accountName") ?? "").trim();
  const debit = Number(formData.get("openingDebit") ?? "0") || 0;
  const credit = Number(formData.get("openingCredit") ?? "0") || 0;
  const note = String(formData.get("note") ?? "").trim() || null;

  if (!fiscalYearId || !accountName) return;
  if (debit > 0 && credit > 0) {
    redirect(`/admin/opening-balances?fy=${fiscalYearId}&error=${encodeURIComponent(`Account "${accountName}": only one of debit/credit may be non-zero`)}`);
  }

  await withActor(me.id, (tx) =>
    tx.accountOpeningBalance.upsert({
      where: {
        fiscalYearId_accountName: { fiscalYearId, accountName },
      },
      create: { fiscalYearId, accountName, openingDebit: debit, openingCredit: credit, note },
      update: { openingDebit: debit, openingCredit: credit, note },
    }),
  );

  revalidatePath("/admin/opening-balances");
  redirect(`/admin/opening-balances?fy=${fiscalYearId}&ok=${encodeURIComponent(accountName)}`);
}

export async function clearOpeningBalance(formData: FormData): Promise<void> {
  const me = await requireRole(["admin", "checker"]);
  const fiscalYearId = String(formData.get("fiscalYearId") ?? "").trim();
  const accountName = String(formData.get("accountName") ?? "").trim();
  if (!fiscalYearId || !accountName) return;
  await withActor(me.id, (tx) =>
    tx.accountOpeningBalance.deleteMany({ where: { fiscalYearId, accountName } }),
  );
  revalidatePath("/admin/opening-balances");
  redirect(`/admin/opening-balances?fy=${fiscalYearId}&ok=${encodeURIComponent(`Cleared ${accountName}`)}`);
}
