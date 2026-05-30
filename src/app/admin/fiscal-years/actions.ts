"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma, withActor } from "@/lib/prisma";
import { requireRole } from "@/lib/auth";

export async function createFiscalYear(formData: FormData): Promise<void> {
  const me = await requireRole(["admin", "checker"]);
  const label = String(formData.get("label") ?? "").trim();
  const startsOn = String(formData.get("startsOn") ?? "").trim();
  const endsOn = String(formData.get("endsOn") ?? "").trim();

  if (!label || !startsOn || !endsOn) {
    redirect(`/admin/fiscal-years?error=Label+and+dates+are+required`);
  }
  try {
    await withActor(me.id, (tx) =>
      tx.fiscalYear.create({
        data: { label, startsOn: new Date(startsOn), endsOn: new Date(endsOn) },
      }),
    );
  } catch (e) {
    redirect(`/admin/fiscal-years?error=${encodeURIComponent(e instanceof Error ? e.message : "create failed")}`);
  }
  revalidatePath("/admin/fiscal-years");
  redirect(`/admin/fiscal-years?ok=${encodeURIComponent(`Created ${label}`)}`);
}

export async function closeFiscalYear(formData: FormData): Promise<void> {
  const me = await requireRole(["admin", "checker"]);
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return;
  await withActor(me.id, (tx) =>
    tx.fiscalYear.update({
      where: { id },
      data: { isClosed: true, closedAt: new Date(), closedBy: me.id },
    }),
  );
  revalidatePath("/admin/fiscal-years");
  redirect(`/admin/fiscal-years?ok=${encodeURIComponent("Closed")}`);
}

export async function reopenFiscalYear(formData: FormData): Promise<void> {
  const me = await requireRole(["admin", "checker"]);
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return;
  await withActor(me.id, (tx) =>
    tx.fiscalYear.update({
      where: { id },
      data: { isClosed: false, closedAt: null, closedBy: null },
    }),
  );
  revalidatePath("/admin/fiscal-years");
  redirect(`/admin/fiscal-years?ok=${encodeURIComponent("Reopened")}`);
}

/**
 * Roll forward closing balances from `sourceId` to `targetId`.
 *
 * Per account:
 *   - Compute closing balance in source FY:
 *       opening (from AccountOpeningBalance)
 *       + Σ debit (from journals where fiscal_year_id = sourceId)
 *       − Σ credit
 *   - If group nature ∈ {ASSET, LIABILITY, EQUITY} → carry forward as
 *     target FY's opening (debit if positive, credit if negative).
 *   - If group nature ∈ {INCOME, EXPENSE} → accumulate into a single
 *     net P&L number, posted to the user-selected `retainedEarningsAccount`
 *     in the target FY's opening as a credit (income) or debit (loss).
 *   - If account has no group → SKIP, show in skipped count.
 *
 * Idempotent: replaces target FY's AccountOpeningBalance rows for any
 * account touched (uses upsert).
 */
export async function rollForward(formData: FormData): Promise<void> {
  const me = await requireRole(["admin", "checker"]);
  const sourceId = String(formData.get("sourceId") ?? "").trim();
  const targetId = String(formData.get("targetId") ?? "").trim();
  const reAccount = String(formData.get("retainedEarningsAccount") ?? "").trim();

  if (!sourceId || !targetId) redirect(`/admin/fiscal-years?error=Source+and+target+required`);
  if (sourceId === targetId) redirect(`/admin/fiscal-years?error=Source+and+target+must+differ`);
  if (!reAccount) redirect(`/admin/fiscal-years?error=Pick+a+Retained+Earnings+account`);

  const reCoa = await prisma.chartOfAccount.findUnique({ where: { name: reAccount } });
  if (!reCoa) redirect(`/admin/fiscal-years?error=${encodeURIComponent(`Account "${reAccount}" not found`)}`);

  const accounts = await prisma.chartOfAccount.findMany({
    include: { group: { select: { nature: true } } },
  });
  const openingBalances = await prisma.accountOpeningBalance.findMany({
    where: { fiscalYearId: sourceId },
  });
  const obMap = new Map(openingBalances.map((o) => [o.accountName, o]));
  const aggs = await prisma.journal.groupBy({
    by: ["accountName"],
    where: { fiscalYearId: sourceId },
    _sum: { debit: true, credit: true },
  });
  const aggMap = new Map(aggs.map((a) => [a.accountName, a]));

  let bsCount = 0;
  let isCount = 0;
  let skipped = 0;
  let netPL = 0; // positive = profit (income > expense), negative = loss

  await withActor(me.id, async (tx) => {
    for (const a of accounts) {
      const ob = obMap.get(a.name);
      const agg = aggMap.get(a.name);
      const openDr = Number(ob?.openingDebit ?? 0);
      const openCr = Number(ob?.openingCredit ?? 0);
      const periodDr = Number(agg?._sum.debit ?? 0);
      const periodCr = Number(agg?._sum.credit ?? 0);
      const closing = openDr + periodDr - openCr - periodCr; // signed: + = Dr, − = Cr

      const nature = a.group?.nature;
      if (!nature) {
        skipped += 1;
        continue;
      }

      if (nature === "INCOME" || nature === "EXPENSE") {
        // Income (CREDIT-normal) closing < 0 = credit balance = profit contribution.
        // Expense (DEBIT-normal) closing > 0 = debit balance = expense contribution.
        // Net P&L = sum of incomes − sum of expenses; in our signed convention
        // (Dr +, Cr −) that's: +closing of EXPENSE accounts adds to expenses
        // (positive = more loss), and +closing of INCOME accounts is unusual
        // (income should be negative/credit). Generic formula: P&L = Σ income
        // − Σ expense. With our sign convention income credit balance is
        // negative, so contribution to profit = −(incomeClosing). Expense
        // contribution to profit = −(expenseClosing).
        netPL += -closing; // expenses (positive) reduce profit; incomes (negative) raise it
        isCount += 1;
        continue;
      }

      // BS account → carry forward
      const newDr = closing > 0 ? closing : 0;
      const newCr = closing < 0 ? -closing : 0;
      if (Math.abs(closing) < 0.005) continue; // nothing to carry
      await tx.accountOpeningBalance.upsert({
        where: {
          fiscalYearId_accountName: { fiscalYearId: targetId, accountName: a.name },
        },
        create: {
          fiscalYearId: targetId,
          accountName: a.name,
          openingDebit: newDr,
          openingCredit: newCr,
          note: `Rolled forward from prior FY closing`,
        },
        update: {
          openingDebit: newDr,
          openingCredit: newCr,
          note: `Rolled forward from prior FY closing`,
        },
      });
      bsCount += 1;
    }

    // Net P&L → Retained Earnings opening of target FY (added to existing balance, if any)
    const existingRE = await tx.accountOpeningBalance.findUnique({
      where: { fiscalYearId_accountName: { fiscalYearId: targetId, accountName: reAccount } },
    });
    const existingDr = Number(existingRE?.openingDebit ?? 0);
    const existingCr = Number(existingRE?.openingCredit ?? 0);
    const existingNet = existingDr - existingCr;
    const newNet = existingNet - netPL; // positive netPL (profit) increases RE credit balance
    const reDr = newNet > 0 ? newNet : 0;
    const reCr = newNet < 0 ? -newNet : 0;
    await tx.accountOpeningBalance.upsert({
      where: { fiscalYearId_accountName: { fiscalYearId: targetId, accountName: reAccount } },
      create: {
        fiscalYearId: targetId,
        accountName: reAccount,
        openingDebit: reDr,
        openingCredit: reCr,
        note: `Includes net P&L roll-forward of ${netPL.toFixed(2)} from source FY`,
      },
      update: {
        openingDebit: reDr,
        openingCredit: reCr,
        note: `Includes net P&L roll-forward of ${netPL.toFixed(2)} from source FY`,
      },
    });
  });

  revalidatePath("/admin/fiscal-years");
  revalidatePath("/admin/opening-balances");
  redirect(
    `/admin/fiscal-years?ok=${encodeURIComponent(
      `Rolled forward: ${bsCount} BS account opening balances, ${isCount} IS accounts collapsed into ${reAccount} (net P&L ${netPL.toFixed(2)})${skipped > 0 ? ` · ${skipped} ungrouped accounts skipped` : ""}`,
    )}`,
  );
}
