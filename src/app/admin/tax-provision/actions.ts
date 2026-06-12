"use server";

// Server actions for the Tax Provision card.
// Phase 2: saveTaxRates (rate edits only).
// Phase 3: postTaxProvision (writes the top-up journal entry,
//   creates a TaxProvision + TaxPosting record, supersedes priors).

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { prisma, withActor } from "@/lib/prisma";
import { requireRole } from "@/lib/auth";
import { allocateVoucherNo } from "@/lib/voucher";
import { computeTaxProvision } from "@/lib/tax-provision";

const ADMIN_PATH = "/admin/tax-provision";

const RATE_TYPES = [
  "CAPITAL_GAIN",
  "DIVIDEND",
  "INTEREST",
  "DEFERRED",
  "MGMT_FEE",
  "CORPORATE",
] as const;

const RateRow = z.object({
  rateType: z.enum(RATE_TYPES),
  /** Percent as user-typed (e.g. "15" for 15%). Coerced to fraction
   *  (0.15) before write. */
  valuePct: z.coerce.number().min(0).max(100),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date"),
  note: z.string().max(500).optional().default(""),
});

const SaveBody = z.object({
  jurisdiction: z.string().min(1).default("BD"),
  rows: z.array(RateRow).min(1).max(20),
});

function back(qs: string, msg: string): never {
  redirect(`${ADMIN_PATH}?${qs}&error=${encodeURIComponent(msg)}`);
}

/**
 * Save (insert) a batch of new rate rows. Each row becomes its own
 * tax_rates record — we never UPDATE an existing row, so the audit
 * trail of "what rate was active when" stays intact. The lookup
 * helper always picks the most recent effective_from ≤ asOfDate.
 *
 * To "edit" a rate, save a NEW row with today's effective_from and
 * the new value.
 */
export async function saveTaxRates(formData: FormData): Promise<void> {
  const profile = await requireRole(["admin", "checker"]);

  // Form payload is repeated rateType[]/valuePct[]/effectiveFrom[]/note[]
  // fields, one per rate row.
  const rateTypes = formData.getAll("rateType").map(String);
  const valuePcts = formData.getAll("valuePct").map(String);
  const effectiveFroms = formData.getAll("effectiveFrom").map(String);
  const notes = formData.getAll("note").map(String);
  const jurisdiction = String(formData.get("jurisdiction") ?? "BD");

  if (
    rateTypes.length !== valuePcts.length ||
    rateTypes.length !== effectiveFroms.length ||
    rateTypes.length !== notes.length
  ) {
    back("", "Form arrays mismatched — rateType / valuePct / effectiveFrom / note counts differ");
  }

  const rows = rateTypes.map((_, i) => ({
    rateType: rateTypes[i],
    valuePct: valuePcts[i],
    effectiveFrom: effectiveFroms[i],
    note: notes[i] ?? "",
  }));

  // Filter empty rows (admin may have added a blank entry).
  const nonEmpty = rows.filter(
    (r) => r.valuePct && r.valuePct.trim() !== "" && r.effectiveFrom && r.effectiveFrom.trim() !== "",
  );

  const parsed = SaveBody.safeParse({ jurisdiction, rows: nonEmpty });
  if (!parsed.success) {
    back("", parsed.error.issues[0]?.message ?? "Invalid input");
  }

  let inserted = 0;
  let skipped = 0;
  for (const r of parsed.data.rows) {
    const value = r.valuePct / 100;
    const effectiveFrom = new Date(`${r.effectiveFrom}T00:00:00Z`);
    // Idempotency: if a row already exists for the same
    // (jurisdiction, rateType, effectiveFrom) tuple, skip — the
    // admin may have re-submitted the form by mistake.
    const existing = await prisma.taxRate.findFirst({
      where: {
        jurisdiction: parsed.data.jurisdiction,
        rateType: r.rateType,
        effectiveFrom,
      },
    });
    if (existing) {
      // If the existing row has a different value, treat as an
      // edit by inserting a NEW row with today's effectiveFrom.
      // This preserves the audit trail.
      if (Math.abs(Number(existing.value) - value) >= 0.000001 || existing.note !== (r.note || null)) {
        await prisma.taxRate.create({
          data: {
            jurisdiction: parsed.data.jurisdiction,
            rateType: r.rateType,
            value,
            effectiveFrom,
            note: r.note || null,
            createdBy: profile.id,
          },
        });
        inserted++;
      } else {
        skipped++;
      }
    } else {
      await prisma.taxRate.create({
        data: {
          jurisdiction: parsed.data.jurisdiction,
          rateType: r.rateType,
          value,
          effectiveFrom,
          note: r.note || null,
          createdBy: profile.id,
        },
      });
      inserted++;
    }
  }

  revalidatePath(ADMIN_PATH);
  revalidatePath("/balance-sheet");
  revalidatePath("/income-statement");
  redirect(
    `${ADMIN_PATH}?ok=${encodeURIComponent(`Saved ${inserted} rate row${inserted === 1 ? "" : "s"}${skipped > 0 ? ` · ${skipped} unchanged` : ""}`)}`,
  );
}

// ─── Phase 3: postTaxProvision ───────────────────────────────────

const PostBody = z.object({
  fiscalYearId: z.string().uuid("Invalid fiscal year"),
  mgmtFeeAtSourceAmount: z.coerce.number().min(0).default(0),
  materialityPct: z.coerce.number().min(0).max(100).default(1.0),
  carryForward: z.coerce.boolean().default(false),
});

const INCOME_TAX_EXPENSE = "Income Tax Expense";
const PROVISION_INCOME_TAX = "Provision for income tax";
const DEFERRED_TAX_EXPENSE = "Deferred Tax Expense";
const DEFERRED_TAX = "Deferred Tax";

/**
 * Recompute the canonical tax provision for `fiscalYearId`, compare
 * against journal accruals AND any prior posted top-ups for the same
 * FY, and post an incremental top-up journal entry covering whatever
 * delta remains. Supersedes prior TaxProvision rows in the same FY so
 * the audit panel always shows one active row per FY.
 */
export async function postTaxProvision(formData: FormData): Promise<void> {
  const profile = await requireRole(["admin", "checker"]);

  const parsed = PostBody.safeParse({
    fiscalYearId: String(formData.get("fiscalYearId") ?? ""),
    mgmtFeeAtSourceAmount: String(formData.get("mgmtFeeAtSourceAmount") ?? "0"),
    materialityPct: String(formData.get("materialityPct") ?? "1.0"),
    carryForward: formData.get("carryForward") === "1" ? "true" : "false",
  });
  if (!parsed.success) {
    back("", parsed.error.issues[0]?.message ?? "Invalid input");
  }
  const data = parsed.data;

  const fy = await prisma.fiscalYear.findUnique({ where: { id: data.fiscalYearId } });
  if (!fy) back(`fy=${data.fiscalYearId}`, "Fiscal year not found");
  if (fy.isClosed) {
    back(
      `fy=${fy.id}`,
      `Fiscal year ${fy.label} is closed. Reopen via /admin/fiscal-years before posting.`,
    );
  }

  // Precondition: the FVTPL "Revalue to market" journal must already be
  // posted — the deferred-tax leg is computed off the unrealised fair-value
  // change it books. The provision voucher is dated the revaluation's date
  // (the latest active FairValueAdjustment.asOfDate).
  const fva = await prisma.fairValueAdjustment.findFirst({
    where: { fiscalYearId: fy.id, reversedAt: null },
    orderBy: { asOfDate: "desc" },
  });
  if (!fva) {
    back(
      `fy=${fy.id}`,
      "Post the FVTPL revaluation (Portfolio → Revalue to market) before the tax provision.",
    );
  }

  // Recompute the canonical numbers — never trust form-submitted
  // tax amounts (would let an admin bypass rate/period validation by
  // editing hidden inputs).
  const result = await computeTaxProvision(fy.id, {
    mgmtFeeAtSourceAmount: data.mgmtFeeAtSourceAmount,
    materialityPct: data.materialityPct / 100,
    lossCarryForwardEnabled: data.carryForward,
  });

  // Sum prior top-ups for the same FY so re-posting after a rate
  // change writes the *delta*, never the full tax twice. Includes
  // both POSTED (active) and SUPERSEDED rows — the journal entries
  // they wrote are still on the books.
  const priorTopups = await prisma.taxPosting.findMany({
    where: { provision: { fiscalYearId: fy.id } },
    select: { type: true, amount: true },
  });
  const currentTopupSum = sumByType(priorTopups, "CURRENT_TAX_TOPUP");
  const deferredTopupSum = sumByType(priorTopups, "DEFERRED_TAX_TOPUP");

  const currentTopup = round2(
    result.currentTax.total - result.reconciliation.journaledCurrentTax - currentTopupSum,
  );
  const deferredTopup = round2(
    result.deferredTax - result.reconciliation.journaledDeferredTax - deferredTopupSum,
  );

  if (Math.abs(currentTopup) < 0.005 && Math.abs(deferredTopup) < 0.005) {
    redirect(
      `${ADMIN_PATH}?fy=${fy.id}&ok=${encodeURIComponent(
        `No top-up needed — current and deferred tax both reconcile within ৳0.01.`,
      )}`,
    );
  }

  // Build journal lines per spec §3.4. Current-tax leg pair + deferred-
  // tax leg pair. Each pair only emitted when its respective topup is
  // non-zero.
  type Line = {
    accountName: string;
    debit: number;
    credit: number;
    description: string;
  };
  const lines: Line[] = [];
  if (Math.abs(currentTopup) >= 0.005) {
    if (currentTopup > 0) {
      // Computed > journaled → ADD to provision.
      lines.push({ accountName: INCOME_TAX_EXPENSE, debit: currentTopup, credit: 0, description: "Current-tax top-up" });
      lines.push({ accountName: PROVISION_INCOME_TAX, debit: 0, credit: currentTopup, description: "Current-tax top-up" });
    } else {
      // Computed < journaled → REVERSE excess provision.
      const abs = Math.abs(currentTopup);
      lines.push({ accountName: PROVISION_INCOME_TAX, debit: abs, credit: 0, description: "Current-tax reversal" });
      lines.push({ accountName: INCOME_TAX_EXPENSE, debit: 0, credit: abs, description: "Current-tax reversal" });
    }
  }
  if (Math.abs(deferredTopup) >= 0.005) {
    if (deferredTopup > 0) {
      lines.push({ accountName: DEFERRED_TAX_EXPENSE, debit: deferredTopup, credit: 0, description: "Deferred-tax top-up (OCI)" });
      lines.push({ accountName: DEFERRED_TAX, debit: 0, credit: deferredTopup, description: "Deferred-tax top-up (OCI)" });
    } else {
      const abs = Math.abs(deferredTopup);
      lines.push({ accountName: DEFERRED_TAX, debit: abs, credit: 0, description: "Deferred-tax reversal (OCI)" });
      lines.push({ accountName: DEFERRED_TAX_EXPENSE, debit: 0, credit: abs, description: "Deferred-tax reversal (OCI)" });
    }
  }

  const batchId = randomUUID();
  let voucherNo = "";
  let provisionId = "";

  // Date the provision voucher on the revaluation's date (the active FVA's
  // asOfDate), clamped to the FY range as a defensive no-op (revalueToMarket
  // already validates asOfDate inside the FY). The statements aggregate by
  // fiscalYearId, so the FY allocation is unaffected either way.
  const clampToFy = (d: Date) =>
    d < fy.startsOn ? fy.startsOn : d > fy.endsOn ? fy.endsOn : d;
  const postDate = clampToFy(fva.asOfDate);

  await withActor(profile.id, async (tx) => {
    voucherNo = await allocateVoucherNo(tx, fy.id, fy.label, "TX");

    // 1. Journal lines — dated the posting day (clamped to the FY).
    await tx.journal.createMany({
      data: lines.map((l) => ({
        entryDate: postDate,
        description: l.description,
        txnType: "TX",
        voucherNo,
        accountName: l.accountName,
        debit: l.debit,
        credit: l.credit,
        fiscalYearId: fy.id,
        batchId,
        createdBy: profile.id,
      })),
    });

    // 2. Mark any prior POSTED provisions for this FY as SUPERSEDED.
    // The history panel still shows them; only the latest is "live".
    await tx.taxProvision.updateMany({
      where: { fiscalYearId: fy.id, status: "POSTED" },
      data: { status: "SUPERSEDED" },
    });

    // 3. Find-or-create a TaxPeriod row for the FY's date range so
    // the TaxProvision row has a periodId FK target. Status stays
    // DRAFT — the FiscalYear.isClosed flag is the lock signal in
    // this codebase, not TaxPeriod.status.
    const period = await tx.taxPeriod.upsert({
      where: { startDate_endDate: { startDate: fy.startsOn, endDate: fy.endsOn } },
      update: {},
      create: { startDate: fy.startsOn, endDate: fy.endsOn, status: "OPEN" },
    });

    // 4. TaxProvision snapshot.
    const created = await tx.taxProvision.create({
      data: {
        periodId: period.id,
        fiscalYearId: fy.id,
        computedBy: profile.id,
        currentTaxCg: result.currentTax.cg,
        currentTaxDividend: result.currentTax.dividend,
        currentTaxInterest: result.currentTax.interest,
        currentTaxMgmt: result.currentTax.mgmt,
        currentTaxBusiness: result.currentTax.business,
        currentTaxTotal: result.currentTax.total,
        deferredTaxTotal: result.deferredTax,
        varianceCurrent: currentTopup,
        varianceDeferred: deferredTopup,
        ratesSnapshot: result.taxRates,
        basesSnapshot: result.bases,
        status: "POSTED",
      },
    });
    provisionId = created.id;

    // 5. TaxPosting rows — one per non-zero topup type.
    const postings: Array<{ provisionId: string; journalBatchId: string; postedBy: string; amount: number; type: string }> = [];
    if (Math.abs(currentTopup) >= 0.005) {
      postings.push({
        provisionId: created.id,
        journalBatchId: batchId,
        postedBy: profile.id,
        amount: currentTopup,
        type: "CURRENT_TAX_TOPUP",
      });
    }
    if (Math.abs(deferredTopup) >= 0.005) {
      postings.push({
        provisionId: created.id,
        journalBatchId: batchId,
        postedBy: profile.id,
        amount: deferredTopup,
        type: "DEFERRED_TAX_TOPUP",
      });
    }
    if (postings.length > 0) {
      await tx.taxPosting.createMany({ data: postings });
    }
  });

  revalidatePath(ADMIN_PATH);
  revalidatePath("/balance-sheet");
  revalidatePath("/income-statement");
  revalidatePath("/trial-balance");
  revalidatePath("/day-book");
  revalidatePath("/journals");

  const parts: string[] = [];
  if (Math.abs(currentTopup) >= 0.005)
    parts.push(`current ${currentTopup >= 0 ? "+" : "−"}৳${Math.abs(currentTopup).toFixed(2)}`);
  if (Math.abs(deferredTopup) >= 0.005)
    parts.push(`deferred ${deferredTopup >= 0 ? "+" : "−"}৳${Math.abs(deferredTopup).toFixed(2)}`);
  redirect(
    `${ADMIN_PATH}?fy=${fy.id}&ok=${encodeURIComponent(`Posted voucher ${voucherNo} · ${parts.join(", ")}`)}`,
  );
}

function sumByType(rows: Array<{ type: string; amount: { toString(): string } }>, type: string): number {
  return rows
    .filter((r) => r.type === type)
    .reduce((s, r) => s + Number(r.amount), 0);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
