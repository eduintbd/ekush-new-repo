"use server";

// Server actions behind /admin/agents/[id]/profile — the agent's own
// profile record: personal + contact details, payout bank accounts, and
// nominee. Document upload is NOT here: files need multipart, which this
// repo deliberately routes through an API route instead of a server
// action (same reasoning as api/agent/investors/create).
//
// Everything is admin/checker only. The agent sees the same data
// read-only at /agent/profile.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { Prisma } from "@/generated/prisma";
import { prisma, withActor } from "@/lib/prisma";
import { requireRole } from "@/lib/auth";

function profilePath(agentId: string): string {
  return `/admin/agents/${agentId}/profile`;
}

function back(agentId: string, msg: string, kind: "ok" | "error" = "ok"): never {
  redirect(`${profilePath(agentId)}?${kind}=${encodeURIComponent(msg)}`);
}

function str(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

/** Trimmed value, or null when blank — so clearing a field really clears it. */
function nullable(formData: FormData, key: string): string | null {
  return str(formData, key) || null;
}

/**
 * Parse a yyyy-mm-dd date input into a UTC midnight Date.
 * Returns undefined for blank (leave unchanged is not wanted here — blank
 * means "clear it", so callers map undefined to null themselves).
 */
function parseDate(raw: string): Date | null | "invalid" {
  if (!raw) return null;
  const d = new Date(`${raw}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? "invalid" : d;
}

/** Digits-only check that tolerates spaces/dashes as typed. */
function digitsOnly(value: string): string {
  return value.replace(/[\s-]/g, "");
}

export async function updateAgentProfile(formData: FormData): Promise<void> {
  const me = await requireRole(["admin", "checker"]);
  const agentId = str(formData, "agentId");
  if (!agentId) redirect("/admin/agents?error=Missing+agent");

  const fullName = str(formData, "fullName");
  if (!fullName) back(agentId, "Full name is required.", "error");

  const email = str(formData, "email").toLowerCase();
  if (!email) back(agentId, "Email is required.", "error");

  const nid = nullable(formData, "nidNumber");
  if (nid && !/^\d{10}$|^\d{13}$|^\d{17}$/.test(digitsOnly(nid))) {
    back(agentId, "NID must be 10, 13 or 17 digits.", "error");
  }
  const tin = nullable(formData, "tinNumber");
  if (tin && !/^\d{12}$/.test(digitsOnly(tin))) {
    back(agentId, "TIN must be 12 digits.", "error");
  }

  const dob = parseDate(str(formData, "dateOfBirth"));
  if (dob === "invalid") back(agentId, "Invalid date of birth.", "error");
  const joined = parseDate(str(formData, "joinedOn"));
  if (joined === "invalid") back(agentId, "Invalid joining date.", "error");

  try {
    await withActor(me.id, (tx) =>
      tx.sellingAgent.update({
        where: { id: agentId },
        data: {
          fullName,
          email,
          phone: nullable(formData, "phone"),
          title: nullable(formData, "title"),
          fatherName: nullable(formData, "fatherName"),
          dateOfBirth: dob,
          address: nullable(formData, "address"),
          nidNumber: nid,
          tinNumber: tin,
          designation: nullable(formData, "designation"),
          joinedOn: joined,
          notes: nullable(formData, "notes"),
        },
      }),
    );
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      back(agentId, `Another agent already uses the email ${email}.`, "error");
    }
    throw err;
  }

  // The agent's own name/email surface on the detail page and the list.
  revalidatePath(profilePath(agentId));
  revalidatePath(`/admin/agents/${agentId}`);
  revalidatePath("/admin/agents");
  back(agentId, "Profile saved.");
}

export async function addAgentBankAccount(formData: FormData): Promise<void> {
  const me = await requireRole(["admin", "checker"]);
  const agentId = str(formData, "agentId");
  if (!agentId) redirect("/admin/agents?error=Missing+agent");

  const bankName = str(formData, "bankName");
  const accountNumber = digitsOnly(str(formData, "accountNumber"));
  if (!bankName || !accountNumber) {
    back(agentId, "Bank name and account number are required.", "error");
  }

  await withActor(me.id, async (tx) => {
    const existing = await tx.agentBankAccount.count({ where: { agentId } });
    // First account is the payout account by default; after that the
    // admin picks explicitly via "Make primary".
    const isPrimary = existing === 0;
    await tx.agentBankAccount.create({
      data: {
        agentId,
        bankName,
        branchName: nullable(formData, "branchName"),
        accountName: nullable(formData, "accountName"),
        accountNumber,
        routingNumber: nullable(formData, "routingNumber"),
        isPrimary,
      },
    });
  });

  revalidatePath(profilePath(agentId));
  back(agentId, "Bank account added.");
}

export async function setPrimaryAgentBank(formData: FormData): Promise<void> {
  const me = await requireRole(["admin", "checker"]);
  const agentId = str(formData, "agentId");
  const bankId = str(formData, "bankId");
  if (!agentId || !bankId) redirect("/admin/agents?error=Missing+bank+account");

  await withActor(me.id, async (tx) => {
    // Scope the demote to this agent AND confirm the target belongs to
    // them, so a forged bankId can't re-point another agent's payout.
    const target = await tx.agentBankAccount.findFirst({ where: { id: bankId, agentId } });
    if (!target) return;
    await tx.agentBankAccount.updateMany({ where: { agentId }, data: { isPrimary: false } });
    await tx.agentBankAccount.update({ where: { id: bankId }, data: { isPrimary: true } });
  });

  revalidatePath(profilePath(agentId));
  back(agentId, "Primary payout account updated.");
}

export async function deleteAgentBankAccount(formData: FormData): Promise<void> {
  const me = await requireRole(["admin", "checker"]);
  const agentId = str(formData, "agentId");
  const bankId = str(formData, "bankId");
  if (!agentId || !bankId) redirect("/admin/agents?error=Missing+bank+account");

  let removedPrimary = false;
  await withActor(me.id, async (tx) => {
    const target = await tx.agentBankAccount.findFirst({ where: { id: bankId, agentId } });
    if (!target) return;
    await tx.agentBankAccount.delete({ where: { id: bankId } });
    removedPrimary = target.isPrimary;
    if (removedPrimary) {
      // Never leave an agent with accounts but no payout target.
      const next = await tx.agentBankAccount.findFirst({
        where: { agentId },
        orderBy: { createdAt: "asc" },
      });
      if (next) {
        await tx.agentBankAccount.update({ where: { id: next.id }, data: { isPrimary: true } });
      }
    }
  });

  revalidatePath(profilePath(agentId));
  back(agentId, removedPrimary ? "Account removed; the oldest remaining account is now primary." : "Bank account removed.");
}

export async function addAgentNominee(formData: FormData): Promise<void> {
  const me = await requireRole(["admin", "checker"]);
  const agentId = str(formData, "agentId");
  if (!agentId) redirect("/admin/agents?error=Missing+agent");

  const name = str(formData, "name");
  if (!name) back(agentId, "Nominee name is required.", "error");

  const nid = nullable(formData, "nidNumber");
  if (nid && !/^\d{10}$|^\d{13}$|^\d{17}$/.test(digitsOnly(nid))) {
    back(agentId, "Nominee NID must be 10, 13 or 17 digits.", "error");
  }

  const dob = parseDate(str(formData, "dateOfBirth"));
  if (dob === "invalid") back(agentId, "Invalid nominee date of birth.", "error");

  const shareRaw = str(formData, "share") || "100";
  const share = Number(shareRaw);
  if (!Number.isFinite(share) || share <= 0 || share > 100) {
    back(agentId, "Nominee share must be between 0 and 100.", "error");
  }

  await withActor(me.id, async (tx) => {
    const total = await tx.agentNominee.aggregate({
      where: { agentId },
      _sum: { share: true },
    });
    const used = Number(total._sum.share ?? 0);
    if (used + share > 100) {
      // Redirecting inside the tx callback would abort it mid-flight;
      // throw a sentinel and translate it outside instead.
      throw new ShareExceeded(used);
    }
    await tx.agentNominee.create({
      data: {
        agentId,
        name,
        relationship: nullable(formData, "relationship"),
        nidNumber: nid,
        dateOfBirth: dob,
        address: nullable(formData, "address"),
        share: new Prisma.Decimal(share.toFixed(2)),
      },
    });
  }).catch((err: unknown) => {
    if (err instanceof ShareExceeded) {
      back(agentId, `Nominee shares already total ${err.used}% — the remainder is ${100 - err.used}%.`, "error");
    }
    throw err;
  });

  revalidatePath(profilePath(agentId));
  back(agentId, "Nominee added.");
}

class ShareExceeded extends Error {
  constructor(public used: number) {
    super("share exceeded");
  }
}

export async function deleteAgentNominee(formData: FormData): Promise<void> {
  const me = await requireRole(["admin", "checker"]);
  const agentId = str(formData, "agentId");
  const nomineeId = str(formData, "nomineeId");
  if (!agentId || !nomineeId) redirect("/admin/agents?error=Missing+nominee");

  // deleteMany (not delete) so the agentId scope is part of the WHERE —
  // a forged nomineeId belonging to another agent simply matches nothing.
  await withActor(me.id, (tx) =>
    tx.agentNominee.deleteMany({ where: { id: nomineeId, agentId } }),
  );

  revalidatePath(profilePath(agentId));
  back(agentId, "Nominee removed.");
}

export async function deleteAgentDocument(formData: FormData): Promise<void> {
  const me = await requireRole(["admin", "checker"]);
  const agentId = str(formData, "agentId");
  const docId = str(formData, "docId");
  if (!agentId || !docId) redirect("/admin/agents?error=Missing+document");

  const doc = await prisma.agentDocument.findFirst({ where: { id: docId, agentId } });
  if (!doc) back(agentId, "Document not found.", "error");

  await withActor(me.id, (tx) => tx.agentDocument.deleteMany({ where: { id: docId, agentId } }));

  // Best-effort storage cleanup. The DB row is the source of truth for
  // what the UI shows, so an orphaned object is cosmetic — never fail
  // the delete over it.
  try {
    const { createSupabaseAdminClient } = await import("@/lib/supabase/admin");
    const admin = createSupabaseAdminClient();
    if (admin) await admin.storage.from("kyc-documents").remove([doc.filePath]);
  } catch {
    // ignore — row is already gone
  }

  revalidatePath(profilePath(agentId));
  back(agentId, "Document removed.");
}
