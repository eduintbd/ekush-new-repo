// POST /api/agent/investors/create — a sales agent onboards a new investor.
// Writes a PENDING registration to the SHARED portal DB (User + Investor +
// Nominee + BankAccount + Document + REGISTRATION KycRecord) so it lands on the
// portal admin's "Pending KYC" dashboard, tagged with the sourcing agent code.
// The agent never sets an investor code or triggers the welcome email — the
// admin does that on approval (unchanged portal flow).

import { randomUUID, randomBytes, createHash } from "crypto";
import { hash } from "bcryptjs";
import type { NextRequest } from "next/server";
import { getAgentScope } from "@/lib/agent-scope";
import { prisma } from "@/lib/prisma";
import { uploadKycFile, KycUploadError } from "@/lib/kyc-upload";
import { mapWithConcurrency } from "@/lib/concurrency";

export const runtime = "nodejs";
export const maxDuration = 60;
// Supabase — both the Postgres pooler and the storage bucket — lives in
// ap-northeast-1. This route makes on the order of twenty sequential round
// trips to it, so running the function anywhere else pays that distance twenty
// times over: from the default US East it was roughly five seconds of the ten
// this request used to take. hnd1 is Vercel's Tokyo region, next door to the
// database. It is also closer to the agents in Bangladesh than US East was, so
// the client leg gets shorter too.
export const preferredRegion = "hnd1";

// (form field name → Document.type, on-screen label). Only these files are
// accepted. The label is what a rejection quotes back: "Nominee NID — front:
// File is too large (7.4 MB)". Without it the agent got the reason but not the
// slot, and had to guess which of nine uploads to fix.
const FILE_FIELDS: Array<[string, string, string]> = [
  ["photo", "PHOTO", "Photograph"],
  ["signature", "SIGNATURE", "Signature"],
  ["nidFront", "NID_FRONT", "NID — front"],
  ["nidBack", "NID_BACK", "NID — back"],
  ["tinCert", "TIN_CERT", "e-TIN certificate"],
  ["chequeLeafPhoto", "CHEQUE_LEAF_PHOTO", "Cheque leaf"],
  ["nomineePhoto", "NOMINEE_PHOTO", "Nominee photo"],
  ["nomineeNidFront", "NOMINEE_NID_FRONT", "Nominee NID — front"],
  ["nomineeNidBack", "NOMINEE_NID_BACK", "Nominee NID — back"],
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
  // form, e.g. PENDING-S00001-PNZXP.
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
  // Deliberately just the agent code plus the shortest discriminator that keeps
  // it unique. A yymmdd segment was tried and dropped: it lengthened the code
  // without telling the accountant anything the "Registered" column does not
  // already show. The trailing group cannot go as well — investors.investorCode
  // is unique, so a second registration by the same agent would collide on a
  // bare PENDING-S00001.
  //
  // The suffix uses a 32-symbol alphabet with the ambiguous glyphs (0/O, 1/I)
  // removed, since this gets read down a phone. Filtering base64 to
  // alphanumerics was tried first and rejected: the filter plus the padding it
  // needed cost enough entropy to collide in a 20k sample.
  const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const encodeRef = (bytes: Uint8Array) =>
    Array.from(bytes.subarray(0, 5))
      .map((b) => ALPHABET[b % ALPHABET.length])
      .join("");
  const newRef = () => `${scope.agentCode}-${encodeRef(randomBytes(5))}`;

  // ── Idempotency ────────────────────────────────────────────────────────
  // The client retries automatically when the connection drops, because a
  // dropped upload is by far the most common way this form fails: agents fill
  // it for several minutes on a phone link, and the socket is often dead by
  // the time they press Submit. A blind retry is dangerous though — if the
  // FIRST attempt actually reached us and only the ANSWER was lost, the
  // retry would register the same investor twice.
  //
  // So the reference is derived from a per-form-fill key the client sends,
  // instead of being random: the same fill always computes the same
  // PENDING-<agent>-<suffix>, and investors."investorCode" is UNIQUE. That
  // makes the unique index itself the idempotency store — no extra table, no
  // migration on the shared portal DB, and the code stays readable down a
  // phone.
  const submissionKey = s(form, "submissionKey");
  const derivedRef = submissionKey
    ? `${scope.agentCode}-${encodeRef(
        createHash("sha256").update(`${scope.agentId}:${submissionKey}`).digest(),
      )}`
    : null;

  // Who already owns a reference, if anyone. Used both to spot a replay and
  // to tell a replay apart from a genuine suffix collision.
  async function ownerOf(code: string): Promise<string | null> {
    const rows = await prisma.$queryRawUnsafe<Array<{ email: string }>>(
      `SELECT u.email FROM public.investors i
         JOIN public.users u ON u.id = i."userId"
        WHERE i."investorCode" = $1 LIMIT 1`,
      code,
    );
    return rows[0]?.email?.toLowerCase() ?? null;
  }

  let reference: string;
  const replayOwner = derivedRef ? await ownerOf(`PENDING-${derivedRef}`) : null;
  if (derivedRef && replayOwner === email) {
    // This exact fill already landed. Answer as though it had just succeeded —
    // same reference, so the agent sees one registration and one code.
    return Response.json({
      ok: true,
      tempCode: `PENDING-${derivedRef}`,
      reference: derivedRef,
      agentCode: scope.agentCode,
      replay: true,
    });
  } else if (derivedRef && replayOwner === null) {
    reference = derivedRef;
  } else {
    // No key (an older cached page), or — at odds of 1 in 33 million — the
    // derived suffix belongs to a different registration. Fall back to the
    // random reference, checking it is free first: file uploads happen below,
    // so an unchecked collision would fail the insert only after the agent had
    // waited through nine uploads, with everything to re-enter.
    reference = newRef();
    for (let attempt = 0; attempt < 5; attempt++) {
      const clash = await prisma.$queryRawUnsafe<Array<{ one: number }>>(
        `SELECT 1 AS one FROM public.investors WHERE "investorCode" = $1 LIMIT 1`,
        `PENDING-${reference}`,
      );
      if (clash.length === 0) break;
      reference = newRef();
    }
  }
  const tempCode = `PENDING-${reference}`;

  // Independent of the uploads, and 60-150ms of CPU on a small function.
  // Started here and awaited after the pool so it overlaps them for free.
  const passwordHashPromise = hash(randomBytes(32).toString("hex"), 10);
  // A bad file makes the scan below return before this is ever awaited, and
  // Node kills the process on an unhandled rejection. Marking it handled here
  // costs nothing and does not swallow anything: awaiting the same promise
  // further down still throws if it failed.
  passwordHashPromise.catch(() => {});

  // 1. Upload KYC files first (need investorId for the storage key). Any bad
  //    file aborts before we write DB rows (orphan uploads are harmless).
  //
  // Three at a time, not nine. The cost of each upload is mostly a round trip
  // to storage, which overlaps; the sharp re-encode is CPU-bound and does not
  // go faster than the function's vCPU count however many run at once. So the
  // win saturates quickly, and past ~3 the extra width only buys peak memory,
  // libvips contention, and a slower rejection path — a bad file at index 0
  // still has to wait for whatever is already in flight beside it. With
  // limitInputPixels capped in kyc-upload.ts this is a real ceiling, not a
  // hope: 3 × 50 MP × 3 bytes ≈ 450 MB.
  //
  // Set to 1 to reproduce the old strictly-sequential behaviour exactly.
  const KYC_UPLOAD_CONCURRENCY = 3;

  // Only slots that actually carry a file enter the pool, so an empty input can
  // never occupy a result index. Built in FILE_FIELDS order — both the failure
  // scan and the `docs` array depend on that ordering.
  const queued = FILE_FIELDS.flatMap(([field, docType, label]) => {
    const f = form.get(field);
    return f instanceof File && f.size > 0 ? [{ field, docType, label, file: f }] : [];
  });

  const settled = await mapWithConcurrency(queued, KYC_UPLOAD_CONCURRENCY, (q) =>
    uploadKycFile(q.file, { investorId, docType: q.docType }),
  );

  // Everything has settled; now answer exactly as the sequential loop did. The
  // first failure by FILE_FIELDS POSITION wins, not the first to fail in time,
  // so the agent gets the same slot label and the same HTTP status regardless
  // of which upload happened to lose the race.
  //
  // Do NOT "optimise" this by cancelling dispatch once something fails. If
  // index 5 fails first in time and later items stop being dispatched, index 2
  // may never have run at all, and the scan below would pick that hole ahead of
  // the real failure — wrong label, wrong status.
  const docs: Array<{ type: string; fileName: string; filePath: string; mimeType: string }> = [];
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    const { field, docType, label } = queued[i];
    if (!r.ok) {
      const e = r.error;
      if (e instanceof KycUploadError) {
        return Response.json({ ok: false, error: `${label}: ${e.message}` }, { status: e.status });
      }
      console.error(`[agent/investors/create] ${field} upload failed`, e);
      return Response.json(
        { ok: false, error: `${label}: the file could not be uploaded. Try a different photo of the same document.` },
        { status: 500 },
      );
    }
    docs.push({
      type: docType,
      fileName: r.value.displayName,
      filePath: r.value.filePath,
      mimeType: r.value.storedMimeType,
    });
  }

  const passwordHash = await passwordHashPromise;
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

      // One statement, not one per document. Nine separate INSERTs meant nine
      // sequential round trips to Tokyo inside the transaction, which is most
      // of what the transaction cost. Parameters are still bound, never
      // interpolated — only the (…) placeholder groups are built by hand.
      if (docs.length > 0) {
        const values = docs
          .map((_, i) => {
            const p = i * 6;
            return `($${p + 1},$${p + 2},$${p + 3},$${p + 4},$${p + 5},$${p + 6}, now())`;
          })
          .join(", ");
        await tx.$executeRawUnsafe(
          `INSERT INTO public.documents (id, "investorId", type, "fileName", "filePath", "mimeType", "createdAt")
           VALUES ${values}`,
          ...docs.flatMap((d) => [randomUUID(), investorId, d.type, d.fileName, d.filePath, d.mimeType]),
        );
      }

      await tx.$executeRawUnsafe(
        `INSERT INTO public.kyc_records (id, "investorId", type, status, "documentUrl", "createdAt", "updatedAt")
         VALUES ($1,$2,'REGISTRATION','PENDING',$3, now(), now())`,
        randomUUID(), investorId, JSON.stringify(snapshot),
      );
    });
  } catch (e) {
    // Two retries can be in flight at once — the browser gave up on the first
    // and sent a second while the first was still writing. Both pass the
    // pre-check above, and the unique index on "investorCode" then rejects
    // whichever commits last. That is the idempotency guard doing its job, not
    // a failure: re-read the row and answer with the reference that won.
    if (derivedRef && (await ownerOf(tempCode)) === email) {
      return Response.json({
        ok: true,
        tempCode,
        reference: derivedRef,
        agentCode: scope.agentCode,
        replay: true,
      });
    }
    const message = e instanceof Error ? e.message : "";
    if (/users_email_key|users_email_unique/i.test(message)) {
      return Response.json(
        { ok: false, error: `${email} is already registered on the portal. Use the investor's own email address, or ask the admin to check the existing account.` },
        { status: 409 },
      );
    }
    return Response.json(
      { ok: false, error: message || "Could not save the registration." },
      { status: 500 },
    );
  }

  return Response.json({ ok: true, tempCode, reference, agentCode: scope.agentCode });
}
