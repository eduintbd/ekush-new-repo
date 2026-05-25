"use server";

// Phase-2 server actions for the Tax Provision card. Only writes
// supported here are rate edits — no posting (Phase 3) or locking
// (Phase 3) yet.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireRole } from "@/lib/auth";

const ADMIN_PATH = "/admin/tax-provision";

const RATE_TYPES = ["CAPITAL_GAIN", "DIVIDEND", "INTEREST", "DEFERRED", "MGMT_FEE"] as const;

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
  const profile = await requireRole(["admin"]);

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
