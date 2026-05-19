"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { prisma, withActor } from "@/lib/prisma";
import { requireRole, canEdit } from "@/lib/auth";

const UPDATE_REDIRECT = "/day-book";

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
  costCentreCode: z.string().optional(),
  investorCode: z.string().optional(),
  /** Stock ticker (Note 19.01) or bank-account code (Note 20). */
  instrumentCode: z.string().optional(),
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
    costCentreCode: String(formData.get("costCentreCode") ?? "") || undefined,
    investorCode: String(formData.get("investorCode") ?? "") || undefined,
    instrumentCode: String(formData.get("instrumentCode") ?? "") || undefined,
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

  // Voucher prefix: OB for opening balance entries, JV for everything else.
  // (Future RV/PV/CV when we add Receipt/Payment/Contra voucher types.)
  const prefix = data.txnType === "OB" ? "OB" : "JV";
  // 'FY2025-26' -> '25-26'
  const fyMatch = fy.label.match(/(\d{2})(\d{2})-(\d{2})/);
  const fyShort = fyMatch ? `${fyMatch[2]}-${fyMatch[3]}` : fy.label.replace(/^FY/, "");

  // Single batch_id ties lines together for compound entries. Wrapped in
  // withActor so the audit-log trigger records `profile.id` against each
  // journal.create row. Voucher number allocated inside the transaction to
  // avoid races between concurrent saves.
  const batchId = randomUUID();
  let assignedVoucherNo = "";
  await withActor(profile.id, async (tx) => {
    const latest = await tx.$queryRawUnsafe<Array<{ max_seq: string | null }>>(
      `SELECT MAX(SUBSTRING(voucher_no FROM '${prefix}/${fyShort}/([0-9]+)$')) AS max_seq
       FROM xsystem.journals
       WHERE fiscal_year_id = $1::uuid AND voucher_no LIKE '${prefix}/${fyShort}/%'`,
      data.fiscalYearId,
    );
    const nextSeq = Number(latest[0]?.max_seq ?? 0) + 1;
    const voucherNo = `${prefix}/${fyShort}/${String(nextSeq).padStart(4, "0")}`;
    assignedVoucherNo = voucherNo;

    await tx.journal.createMany({
      data: data.lines.map((l) => ({
        entryDate: entry,
        description: data.description,
        txnType: data.txnType,
        voucherNo,
        accountName: l.accountName,
        debit: l.debit,
        credit: l.credit,
        fiscalYearId: data.fiscalYearId,
        batchId,
        investorCode: data.investorCode,
        fundCode: data.fundCode,
        costCentreCode: data.costCentreCode,
        instrumentCode: data.instrumentCode,
        createdBy: profile.id,
      })),
    });
  });

  revalidatePath("/journals");
  revalidatePath("/day-book");
  revalidatePath("/trial-balance");
  const params = new URLSearchParams({
    created: "1",
    vno: assignedVoucherNo,
    batch: batchId,
  });
  redirect(`/journals?${params.toString()}`);
}

function editBack(batchId: string, error: JournalCreateError): never {
  const params = new URLSearchParams({ err: error.kind, msg: JSON.stringify(error) });
  redirect(`/journals/voucher/${batchId}/edit?${params.toString()}`);
}

/**
 * Replace every line of a batch in one transaction. Voucher#, batchId,
 * and createdBy/createdAt are preserved; everything else (date, narration,
 * lines, fund, cost-centre, …) comes from the form. Refuses to touch
 * batches in a closed fiscal year.
 */
export async function updateJournalBatch(formData: FormData): Promise<void> {
  const profile = await requireRole(["admin", "accountant"]);
  if (!canEdit(profile)) redirect("/day-book?err=role");

  const batchId = String(formData.get("batchId") ?? "");
  if (!batchId) redirect("/day-book?err=missing_batch");

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
    costCentreCode: String(formData.get("costCentreCode") ?? "") || undefined,
    investorCode: String(formData.get("investorCode") ?? "") || undefined,
    instrumentCode: String(formData.get("instrumentCode") ?? "") || undefined,
    fiscalYearId: String(formData.get("fiscalYearId") ?? ""),
    lines,
  });
  if (!parsed.success) {
    editBack(batchId, { kind: "validation", message: parsed.error.issues[0]?.message ?? "invalid" });
  }
  const data = parsed.data;

  const debitTotal = data.lines.reduce((s, l) => s + l.debit, 0);
  const creditTotal = data.lines.reduce((s, l) => s + l.credit, 0);
  if (Math.abs(debitTotal - creditTotal) > 0.005) {
    editBack(batchId, { kind: "unbalanced", debitTotal, creditTotal });
  }

  // Load existing batch to preserve voucherNo / createdBy / createdAt and to
  // refuse edits across a closed fiscal year (either the old FY or the new).
  const existing = await prisma.journal.findMany({
    where: { batchId },
    select: { voucherNo: true, createdBy: true, createdAt: true, fiscalYearId: true },
  });
  if (existing.length === 0) editBack(batchId, { kind: "validation", message: "batch not found" });
  const voucherNo = existing[0].voucherNo;
  const originalCreatedBy = existing[0].createdBy;
  const originalCreatedAt = existing[0].createdAt;
  const originalFyId = existing[0].fiscalYearId;

  const newFy = await prisma.fiscalYear.findUnique({ where: { id: data.fiscalYearId } });
  if (!newFy) editBack(batchId, { kind: "validation", message: "fiscal year not found" });
  if (newFy.isClosed) editBack(batchId, { kind: "fy_closed" });
  const entry = new Date(`${data.entryDate}T00:00:00Z`);
  if (entry < newFy.startsOn || entry > newFy.endsOn) editBack(batchId, { kind: "fy_out_of_range" });

  if (originalFyId !== data.fiscalYearId) {
    const oldFy = await prisma.fiscalYear.findUnique({ where: { id: originalFyId } });
    if (oldFy?.isClosed) editBack(batchId, { kind: "fy_closed" });
  }

  const accountSet = new Set(data.lines.map((l) => l.accountName));
  const found = await prisma.chartOfAccount.findMany({
    where: { name: { in: [...accountSet] } },
    select: { name: true },
  });
  const foundSet = new Set(found.map((a) => a.name));
  for (const a of accountSet) {
    if (!foundSet.has(a)) editBack(batchId, { kind: "unknown_account", account: a });
  }

  await withActor(profile.id, async (tx) => {
    await tx.journal.deleteMany({ where: { batchId } });
    await tx.journal.createMany({
      data: data.lines.map((l) => ({
        entryDate: entry,
        description: data.description,
        txnType: data.txnType,
        voucherNo,
        accountName: l.accountName,
        debit: l.debit,
        credit: l.credit,
        fiscalYearId: data.fiscalYearId,
        batchId,
        investorCode: data.investorCode,
        fundCode: data.fundCode,
        costCentreCode: data.costCentreCode,
        instrumentCode: data.instrumentCode,
        createdBy: originalCreatedBy,
        createdAt: originalCreatedAt,
      })),
    });
  });

  revalidatePath("/journals");
  revalidatePath("/day-book");
  revalidatePath("/trial-balance");
  revalidatePath(`/journals/voucher/${batchId}`);
  redirect(UPDATE_REDIRECT);
}

/**
 * Delete every line of a batch. Refuses to touch batches in a closed
 * fiscal year. Wrapped in withActor so the audit-log trigger records
 * the deletes against the current profile.
 */
export async function deleteJournalBatch(formData: FormData): Promise<void> {
  const profile = await requireRole(["admin", "accountant"]);
  if (!canEdit(profile)) redirect("/day-book?err=role");

  const batchId = String(formData.get("batchId") ?? "");
  if (!batchId) redirect("/day-book?err=missing_batch");

  const lines = await prisma.journal.findMany({
    where: { batchId },
    select: { fiscalYearId: true },
    take: 1,
  });
  if (lines.length === 0) redirect("/day-book?err=batch_not_found");

  const fy = await prisma.fiscalYear.findUnique({ where: { id: lines[0].fiscalYearId } });
  if (fy?.isClosed) redirect("/day-book?err=fy_closed");

  await withActor(profile.id, async (tx) => {
    await tx.journal.deleteMany({ where: { batchId } });
  });

  revalidatePath("/journals");
  revalidatePath("/day-book");
  revalidatePath("/trial-balance");
  redirect("/day-book");
}
