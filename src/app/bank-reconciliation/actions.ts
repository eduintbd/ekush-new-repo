"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma, withActor } from "@/lib/prisma";
import { requireRole } from "@/lib/auth";

function back(error: string): never {
  redirect(`/bank-reconciliation/new?error=${encodeURIComponent(error)}`);
}

export async function saveBankStatement(formData: FormData): Promise<void> {
  const me = await requireRole(["admin", "checker", "accountant"]);

  const accountName = String(formData.get("accountName") ?? "").trim();
  const fiscalYearId = String(formData.get("fiscalYearId") ?? "").trim();
  const periodStart = String(formData.get("periodStart") ?? "").trim();
  const periodEnd = String(formData.get("periodEnd") ?? "").trim();
  const openingBalanceStr = String(formData.get("openingBalance") ?? "0").trim();
  const closingBalanceStr = String(formData.get("closingBalance") ?? "0").trim();
  const sourceFile = String(formData.get("sourceFile") ?? "").trim() || null;
  const notes = String(formData.get("notes") ?? "").trim() || null;

  if (!accountName) back("Account is required.");
  if (!fiscalYearId) back("Fiscal year is required.");
  if (!periodStart || !periodEnd) back("Period start and end dates required.");
  const opening = Number(openingBalanceStr);
  const closing = Number(closingBalanceStr);
  if (!Number.isFinite(opening) || !Number.isFinite(closing)) {
    back("Opening and closing balances must be numbers.");
  }

  const id = await withActor(me.id, async (tx) => {
    const stmt = await tx.bankStatement.upsert({
      where: {
        accountName_periodStart_periodEnd: {
          accountName,
          periodStart: new Date(periodStart),
          periodEnd: new Date(periodEnd),
        },
      },
      create: {
        accountName,
        fiscalYearId,
        periodStart: new Date(periodStart),
        periodEnd: new Date(periodEnd),
        openingBalance: opening,
        closingBalance: closing,
        sourceFile,
        notes,
        uploadedBy: me.id,
      },
      update: {
        fiscalYearId,
        openingBalance: opening,
        closingBalance: closing,
        sourceFile,
        notes,
      },
    });
    return stmt.id;
  });

  revalidatePath("/bank-reconciliation");
  redirect(`/bank-reconciliation/${id}`);
}

export async function deleteBankStatement(formData: FormData): Promise<void> {
  await requireRole(["admin", "checker", "accountant"]);
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return;
  await prisma.bankStatement.delete({ where: { id } });
  revalidatePath("/bank-reconciliation");
  redirect("/bank-reconciliation");
}
