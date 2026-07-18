// POST /api/agent/investors/create — a sales agent onboards a new investor.
// Writes a PENDING registration to the SHARED portal DB (User + Investor +
// Nominee + BankAccount + Document + REGISTRATION KycRecord) so it lands on the
// portal admin's "Pending KYC" dashboard, tagged with the sourcing agent code.
// The agent never sets an investor code or triggers the welcome email — the
// admin does that on approval (unchanged portal flow).

import { randomUUID, randomBytes } from "crypto";
import { hash } from "bcryptjs";
import type { NextRequest } from "next/server";
import { getAgentScope } from "@/lib/agent-scope";
import { prisma } from "@/lib/prisma";
import { uploadKycFile, KycUploadError } from "@/lib/kyc-upload";

export const runtime = "nodejs";
export const maxDuration = 60;

// (form field name → Document.type). Only these files are accepted.
const FILE_FIELDS: Array<[string, string]> = [
  ["photo", "PHOTO"],
  ["signature", "SIGNATURE"],
  ["nidFront", "NID_FRONT"],
  ["nidBack", "NID_BACK"],
  ["tinCert", "TIN_CERT"],
  ["chequeLeafPhoto", "CHEQUE_LEAF_PHOTO"],
  ["nomineePhoto", "NOMINEE_PHOTO"],
  ["nomineeNidFront", "NOMINEE_NID_FRONT"],
  ["nomineeNidBack", "NOMINEE_NID_BACK"],
];

function s(form: FormData, key: string): string {
  return String(form.get(key) ?? "").trim();
}

export async function POST(req: NextRequest) {
  const scope = await getAgentScope();
  if (!scope.agentId) {
    return Response.json({ ok: false, error: "Your account is not linked to an agent record." }, { status: 403 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ ok: false, error: "Invalid form submission." }, { status: 400 });
  }

  const name = s(form, "name");
  const email = s(form, "email").toLowerCase();
  if (!name) return Response.json({ ok: false, error: "Investor name is required." }, { status: 400 });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return Response.json({ ok: false, error: "A valid email is required." }, { status: 400 });
  }

  const userId = randomUUID();
  const investorId = randomUUID();
  const tempCode = `PENDING-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

  // 1. Upload KYC files first (need investorId for the storage key). Any bad
  //    file aborts before we write DB rows (orphan uploads are harmless).
  const docs: Array<{ type: string; fileName: string; filePath: string; mimeType: string }> = [];
  try {
    for (const [field, docType] of FILE_FIELDS) {
      const f = form.get(field);
      if (f instanceof File && f.size > 0) {
        const r = await uploadKycFile(f, { investorId, docType });
        docs.push({ type: docType, fileName: r.displayName, filePath: r.filePath, mimeType: r.storedMimeType });
      }
    }
  } catch (e) {
    if (e instanceof KycUploadError) {
      return Response.json({ ok: false, error: e.message }, { status: e.status });
    }
    return Response.json({ ok: false, error: "A file failed to upload." }, { status: 500 });
  }

  const passwordHash = await hash(randomBytes(32).toString("hex"), 10);
  const dobRaw = s(form, "dateOfBirth");
  const dob = /^\d{4}-\d{2}-\d{2}$/.test(dobRaw) ? new Date(`${dobRaw}T00:00:00.000Z`) : null;

  const snapshot = {
    source: "AGENT_CREATED",
    sourcingAgentCode: scope.agentCode,
    permanentAddress: s(form, "permanentAddress") || null,
    applicant: {
      name,
      presentAddress: s(form, "presentAddress") || null,
      permanentAddress: s(form, "permanentAddress") || null,
      nidNumber: s(form, "nidNumber") || null,
      tinNumber: s(form, "tinNumber") || null,
    },
    jointApplicant: null,
    createdByAgent: scope.agentCode,
    createdAt: new Date().toISOString(),
  };

  const bankName = s(form, "bankName");
  const accountNumber = s(form, "accountNumber");
  const nomineeName = s(form, "nomineeName");
  const chequeKey = docs.find((d) => d.type === "CHEQUE_LEAF_PHOTO")?.filePath ?? null;

  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO public.users (id, email, phone, "passwordHash", role, status, "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, 'INVESTOR', 'PENDING', now(), now())`,
        userId, email, s(form, "phone") || null, passwordHash,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO public.investors
           (id, "userId", "investorCode", name, "investorType", "nidNumber", "tinNumber",
            "dateOfBirth", address, "fatherName", "motherName", "dividendOption",
            "createdAt", "updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now(), now())`,
        investorId, userId, tempCode, name,
        s(form, "investorType") || "INDIVIDUAL",
        s(form, "nidNumber") || null, s(form, "tinNumber") || null, dob,
        s(form, "presentAddress") || null, s(form, "fatherName") || null,
        s(form, "motherName") || null, s(form, "dividendOption") || "CASH",
      );

      if (nomineeName) {
        await tx.$executeRawUnsafe(
          `INSERT INTO public.nominees (id, "investorId", name, relationship, "nidNumber", share, "isMinor", "createdAt", "updatedAt")
           VALUES ($1,$2,$3,$4,$5,100,false, now(), now())`,
          randomUUID(), investorId, nomineeName, s(form, "nomineeRelationship") || null, s(form, "nomineeNidNumber") || null,
        );
      }

      if (bankName && accountNumber) {
        await tx.$executeRawUnsafe(
          `INSERT INTO public.bank_accounts
             (id, "investorId", "bankName", "branchName", "accountNumber", "routingNumber",
              "chequeLeafUrl", "isPrimary", status, "createdAt", "updatedAt")
           VALUES ($1,$2,$3,$4,$5,$6,$7,true,'ACTIVE', now(), now())`,
          randomUUID(), investorId, bankName, s(form, "branchName") || null,
          accountNumber, s(form, "routingNumber") || null, chequeKey,
        );
      }

      for (const d of docs) {
        await tx.$executeRawUnsafe(
          `INSERT INTO public.documents (id, "investorId", type, "fileName", "filePath", "mimeType", "createdAt")
           VALUES ($1,$2,$3,$4,$5,$6, now())`,
          randomUUID(), investorId, d.type, d.fileName, d.filePath, d.mimeType,
        );
      }

      await tx.$executeRawUnsafe(
        `INSERT INTO public.kyc_records (id, "investorId", type, status, "documentUrl", "createdAt", "updatedAt")
         VALUES ($1,$2,'REGISTRATION','PENDING',$3, now(), now())`,
        randomUUID(), investorId, JSON.stringify(snapshot),
      );
    });
  } catch (e) {
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : "Could not save the registration." },
      { status: 500 },
    );
  }

  return Response.json({ ok: true, tempCode });
}
