"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireRole, canEdit } from "@/lib/auth";

const Line = z.object({
  accountName: z.string().min(1),
  debit: z.coerce.number().min(0).default(0),
  credit: z.coerce.number().min(0).default(0),
});

const Body = z.object({
  entryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  description: z.string().optional(),
  txnType: z.string().optional(),
  fundCode: z.string().optional(),
  investorCode: z.string().optional(),
  fiscalYearId: z.string().min(1),
  lines: z.array(Line).min(2),
});

export type JournalCreateError =
  | { kind: "validation"; message: string }
  | { kind: "unbalanced"; debitTotal: number; creditTotal: number }
  | { kind: "fy_closed" }
  | { kind: "fy_out_of_range" }
  | { kind: "unknown_account"; account: string };

function back(error: JournalCreateError): never {
  const params = new URLSearchParams({ err: error.kind, msg: JSON.stringify(error) });
  redirect(`/journals/new?${params.toString()}`);
}

export async function createJournal(formData: FormData): Promise<void> {
  const profile = await requireRole(["admin", "accountant"]);
  if (!canEdit(profile)) back({ kind: "validation", message: "Insufficient role" });

  // Lines come as parallel arrays from the form: account[], debit[], credit[]
  const accounts = formData.getAll("account").map(String);
  const debits = formData.getAll("debit").map(String);
  const credits = formData.getAll("credit").map(String);
  const lines = accounts.map((a, i) => ({
    accountName: a,
    debit: debits[i] ?? "0",
    credit: credits[i] ?? "0",
  }));

  const parsed = Body.safeParse({
    entryDate: String(formData.get("entryDate") ?? ""),
    description: String(formData.get("description") ?? ""),
    txnType: String(formData.get("txnType") ?? "j"),
    fundCode: String(formData.get("fundCode") ?? "") || undefined,
    investorCode: String(formData.get("investorCode") ?? "") || undefined,
    fiscalYearId: String(formData.get("fiscalYearId") ?? ""),
    lines,
  });
  if (!parsed.success) {
    back({ kind: "validation", message: parsed.error.issues[0]?.message ?? "invalid" });
  }
  const data = parsed.data;

  // Σdebit must equal Σcredit
  const debitTotal = data.lines.reduce((s, l) => s + l.debit, 0);
  const creditTotal = data.lines.reduce((s, l) => s + l.credit, 0);
  if (Math.abs(debitTotal - creditTotal) > 0.005) {
    back({ kind: "unbalanced", debitTotal, creditTotal });
  }

  // Fiscal year must exist + be open + contain entryDate
  const fy = await prisma.fiscalYear.findUnique({ where: { id: data.fiscalYearId } });
  if (!fy) back({ kind: "validation", message: "fiscal year not found" });
  if (fy.isClosed) back({ kind: "fy_closed" });
  const entry = new Date(`${data.entryDate}T00:00:00Z`);
  if (entry < fy.startsOn || entry > fy.endsOn) back({ kind: "fy_out_of_range" });

  // Account names must exist (fk constraint will catch this too — pre-check
  // gives a friendlier message)
  const accountSet = new Set(data.lines.map((l) => l.accountName));
  const found = await prisma.chartOfAccount.findMany({
    where: { name: { in: [...accountSet] } },
    select: { name: true },
  });
  const foundSet = new Set(found.map((a) => a.name));
  for (const a of accountSet) {
    if (!foundSet.has(a)) back({ kind: "unknown_account", account: a });
  }

  // Single batch_id ties lines together for compound entries.
  const batchId = randomUUID();
  await prisma.journal.createMany({
    data: data.lines.map((l) => ({
      entryDate: entry,
      description: data.description,
      txnType: data.txnType,
      accountName: l.accountName,
      debit: l.debit,
      credit: l.credit,
      fiscalYearId: data.fiscalYearId,
      batchId,
      investorCode: data.investorCode,
      fundCode: data.fundCode,
      createdBy: profile.id,
    })),
  });

  revalidatePath("/journals");
  revalidatePath("/trial-balance");
  redirect("/journals");
}
