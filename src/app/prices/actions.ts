"use server";

// /prices server actions:
//   - upsertPrices     — bulk close-price entry for one date
//   - addInstrument    — create a new ticker (admin / accountant)
//   - deactivateInstrument — soft-delete (sets isActive=false); journal
//     history + Trade rows are preserved.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireRole, canEdit } from "@/lib/auth";

const PRICES_PATH = "/prices";

const Schema = z.object({
  priceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date required"),
});

const InstrumentBody = z.object({
  code: z.string().min(1, "code required").max(40).regex(/^[A-Z0-9_]+$/, "code must be UPPERCASE letters/digits/underscore"),
  name: z.string().min(1, "name required").max(120),
  category: z.enum(["listed_security", "mutual_fund_open", "private_placement", "ipo_application", "bond"]),
  sector: z.string().max(60).optional(),
  investmentAccount: z.string().min(1, "investment account required"),
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

export async function addInstrument(formData: FormData): Promise<void> {
  const profile = await requireRole(["admin", "accountant"]);
  if (!canEdit(profile)) back("Insufficient role");

  const codeRaw = String(formData.get("code") ?? "").trim().toUpperCase();
  const parsed = InstrumentBody.safeParse({
    code: codeRaw,
    name: String(formData.get("name") ?? "").trim(),
    category: String(formData.get("category") ?? ""),
    sector: String(formData.get("sector") ?? "").trim() || undefined,
    investmentAccount: String(formData.get("investmentAccount") ?? ""),
  });
  if (!parsed.success) back(parsed.error.issues[0]?.message ?? "invalid input");
  const data = parsed.data;

  const existing = await prisma.instrument.findUnique({ where: { code: data.code } });
  if (existing) {
    // Re-activate if previously soft-deleted; otherwise reject as duplicate.
    if (!existing.isActive) {
      await prisma.instrument.update({
        where: { code: data.code },
        data: {
          name: data.name,
          category: data.category,
          sector: data.sector ?? null,
          investmentAccount: data.investmentAccount,
          isActive: true,
        },
      });
      revalidatePath("/prices");
      revalidatePath("/trades/new");
      redirect(`/prices?ok=${encodeURIComponent(`Re-activated ${data.code}`)}`);
    }
    back(`Instrument ${data.code} already exists`);
  }

  const inv = await prisma.chartOfAccount.findUnique({ where: { name: data.investmentAccount } });
  if (!inv) back(`CoA account "${data.investmentAccount}" not found`);

  await prisma.instrument.create({
    data: {
      code: data.code,
      name: data.name,
      category: data.category,
      sector: data.sector ?? null,
      investmentAccount: data.investmentAccount,
    },
  });

  revalidatePath("/prices");
  revalidatePath("/trades/new");
  redirect(`/prices?ok=${encodeURIComponent(`Added ${data.code}`)}`);
}

export async function deactivateInstrument(formData: FormData): Promise<void> {
  const profile = await requireRole(["admin", "accountant"]);
  if (!canEdit(profile)) back("Insufficient role");

  const code = String(formData.get("code") ?? "").trim();
  if (!code) back("Missing instrument code");

  const inst = await prisma.instrument.findUnique({ where: { code } });
  if (!inst) back(`Instrument ${code} not found`);
  if (!inst.isActive) back(`Instrument ${code} already inactive`);

  // Soft delete — keeps Trade + Price history referencing this code.
  await prisma.instrument.update({
    where: { code },
    data: { isActive: false },
  });

  revalidatePath("/prices");
  revalidatePath("/trades/new");
  revalidatePath("/portfolio");
  redirect(`/prices?ok=${encodeURIComponent(`${code} deactivated`)}`);
}
