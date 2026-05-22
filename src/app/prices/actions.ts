"use server";

// Price entry server action. One row = one (instrument, date) pair. The
// page passes the date once and a parallel array of instrument/price
// inputs; we upsert each non-empty one. Empty cells are skipped (not
// deleted) so partial updates are safe.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireRole, canEdit } from "@/lib/auth";

const PRICES_PATH = "/prices";

const Schema = z.object({
  priceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date required"),
});

function back(msg: string): never {
  redirect(`${PRICES_PATH}?error=${encodeURIComponent(msg)}`);
}

export async function upsertPrices(formData: FormData): Promise<void> {
  const profile = await requireRole(["admin", "accountant"]);
  if (!canEdit(profile)) back("Insufficient role");

  const parsed = Schema.safeParse({
    priceDate: String(formData.get("priceDate") ?? ""),
  });
  if (!parsed.success) back(parsed.error.issues[0]?.message ?? "invalid date");

  const priceDate = new Date(`${parsed.data.priceDate}T00:00:00Z`);

  // Form posts parallel arrays: instrumentCode[N], closePrice[N].
  const codes = formData.getAll("instrumentCode").map(String);
  const prices = formData.getAll("closePrice").map(String);

  if (codes.length !== prices.length) back("Form posted mismatched arrays");

  let touched = 0;
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    const raw = prices[i].trim();
    if (!code || !raw) continue;
    const closePrice = Number(raw);
    if (!Number.isFinite(closePrice) || closePrice < 0) {
      back(`Price for ${code} is not a non-negative number`);
    }
    await prisma.price.upsert({
      where: { instrumentCode_priceDate: { instrumentCode: code, priceDate } },
      create: {
        instrumentCode: code,
        priceDate,
        closePrice,
        createdBy: profile.id,
      },
      update: { closePrice },
    });
    touched++;
  }

  revalidatePath("/prices");
  revalidatePath("/portfolio");
  redirect(`/prices?date=${parsed.data.priceDate}&ok=${encodeURIComponent(`Saved ${touched} price${touched === 1 ? "" : "s"}`)}`);
}
