"use server";

// /admin/brokers server actions: CRUD over the Broker master table.
// Patterns mirror /admin/banks. Delete refuses if any Trade row
// references the broker (FK has onDelete: Restrict); admin must
// deactivate (isActive=false) instead.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma, withActor } from "@/lib/prisma";
import { requireRole } from "@/lib/auth";

const PATH = "/admin/brokers";

function back(msg: string): never {
  redirect(`${PATH}?error=${encodeURIComponent(msg)}`);
}

async function validateCoa(name: string, requireDebit: boolean): Promise<void> {
  const acc = await prisma.chartOfAccount.findUnique({ where: { name } });
  if (!acc) back(`CoA account "${name}" not found`);
  if (!acc.isActive) back(`CoA account "${name}" is inactive`);
  if (requireDebit && acc.normalBalance !== "DEBIT") {
    back(`Broker BO account "${name}" must be DEBIT-normal (asset)`);
  }
  if (!requireDebit && acc.normalBalance !== "CREDIT") {
    back(`Margin loan account "${name}" must be CREDIT-normal (liability)`);
  }
}

export async function createBroker(formData: FormData): Promise<void> {
  const me = await requireRole(["admin"]);

  const code = String(formData.get("code") ?? "").trim().toUpperCase();
  const name = String(formData.get("name") ?? "").trim();
  const brokerBoAccount = String(formData.get("brokerBoAccount") ?? "").trim();
  const marginLoanAccount = String(formData.get("marginLoanAccount") ?? "").trim() || null;
  const notes = String(formData.get("notes") ?? "").trim() || null;

  if (!code) back("Code is required");
  if (!/^[A-Z0-9_]+$/.test(code)) back("Code must be UPPERCASE letters/digits/underscore");
  if (!name) back("Name is required");
  if (!brokerBoAccount) back("Broker BO account is required");

  // Reject duplicate code (re-activate path uses the edit form below).
  const existing = await prisma.broker.findUnique({ where: { code } });
  if (existing) back(`Broker ${code} already exists`);

  await validateCoa(brokerBoAccount, /*requireDebit*/ true);
  if (marginLoanAccount) await validateCoa(marginLoanAccount, /*requireDebit*/ false);

  await withActor(me.id, (tx) =>
    tx.broker.create({
      data: { code, name, brokerBoAccount, marginLoanAccount, notes },
    }),
  );
  revalidatePath("/admin/brokers");
  revalidatePath("/trades/new");
  redirect(`${PATH}?ok=${encodeURIComponent(`Added broker ${code}`)}`);
}

export async function updateBroker(formData: FormData): Promise<void> {
  const me = await requireRole(["admin"]);

  const code = String(formData.get("code") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const brokerBoAccount = String(formData.get("brokerBoAccount") ?? "").trim();
  const marginLoanAccount = String(formData.get("marginLoanAccount") ?? "").trim() || null;
  const isActive = String(formData.get("isActive") ?? "true") === "true";
  const notes = String(formData.get("notes") ?? "").trim() || null;

  if (!code) back("Missing broker code");
  if (!name) back("Name is required");
  if (!brokerBoAccount) back("Broker BO account is required");

  await validateCoa(brokerBoAccount, /*requireDebit*/ true);
  if (marginLoanAccount) await validateCoa(marginLoanAccount, /*requireDebit*/ false);

  await withActor(me.id, (tx) =>
    tx.broker.update({
      where: { code },
      data: { name, brokerBoAccount, marginLoanAccount, isActive, notes },
    }),
  );
  revalidatePath("/admin/brokers");
  revalidatePath("/trades/new");
  redirect(`${PATH}?ok=${encodeURIComponent(`Updated ${code}`)}`);
}

export async function deleteBroker(formData: FormData): Promise<void> {
  const me = await requireRole(["admin"]);
  const code = String(formData.get("code") ?? "").trim();
  if (!code) back("Missing broker code");

  // Refuse if any Trade row references this broker (Restrict FK).
  const tradeCount = await prisma.trade.count({ where: { brokerCode: code } });
  if (tradeCount > 0) {
    back(
      `Broker ${code} is referenced by ${tradeCount} trade(s). Deactivate it (isActive=false) instead of deleting.`,
    );
  }

  await withActor(me.id, (tx) => tx.broker.delete({ where: { code } }));
  revalidatePath("/admin/brokers");
  revalidatePath("/trades/new");
  redirect(`${PATH}?ok=${encodeURIComponent(`Removed broker ${code}`)}`);
}
