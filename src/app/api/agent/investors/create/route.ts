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
  // Reference number the accountant can trace back to the agent who filled the
  // form, e.g. PENDING-S00001-260806-K3F9.
  //
  // The "PENDING-" prefix is NOT decoration and must stay first: the portal
  // treats it as the marker for "no real investor code yet" in at least eight
  // places — assigning the real code on approval, locking KYC fields on
  // /profile, suppressing the welcome WhatsApp so it never quotes a
  // placeholder, the pending banner on the investor dashboard, and the xlsx
  // import's code matching. This repo relies on it too (agent-sourced.ts
  // filters `code NOT LIKE 'PENDING-%'`). Embedding the agent code INSIDE the
  // prefix gives the accountant a readable reference without disturbing any of
  // that.
  //
  // Replaced `PENDING-<base36 ts><3 random>`, which was unreadable and said
  // nothing about who submitted it.
  //
  // The suffix is drawn from a 32-symbol alphabet with the ambiguous glyphs
  // (0/O, 1/I) removed, since this is a number people read down a phone. That
  // is 32^5 ≈ 33.5M per agent per day against the unique constraint on
  // investors.investorCode. Filtering base64 down to alphanumerics was tried
  // first and rejected: the filter plus the padding it needed cost enough
  // entropy to produce collisions in a 20k sample.
  const refDate = new Date().toISOString().slice(2, 10).replace(/-/g, ""); // yymmdd
  const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const newRef = () =>
    `${scope.agentCode}-${refDate}-${Array.from(randomBytes(5))
      .map((b) => ALPHABET[b % ALPHABET.length])
      .join("")}`;

  // Confirm the code is free before doing anything else. The odds of a clash
  // are tiny, but the cost is not: file uploads happen below, so an unchecked
  // collision would fail the insert only after the agent had waited through
  // nine uploads, with everything to re-enter. Checking here is one indexed
  // lookup on a unique column.
  let reference = newRef();
  for (let attempt = 0; attempt < 5; attempt++) {
    const clash = await prisma.$queryRawUnsafe<Array<{ one: number }>>(
      `SELECT 1 AS one FROM public.investors WHERE "investorCode" = $1 LIMIT 1`,
      `PENDING-${reference}`,
    );
    if (clash.length === 0) break;
    reference = newRef();
  }
  const tempCode = `PENDING-${reference}`;

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
    // Kept here as well as in the temp code, because the temp code is
    // overwritten with the real A00xxx the moment the admin approves. The
    // snapshot is permanent, so the reference stays traceable afterwards.
    agentReference: reference,
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

  return Response.json({ ok: true, tempCode, reference, agentCode: scope.agentCode });
}
