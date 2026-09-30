"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { UPLOAD_ATTEMPTS, uploadKycDocument, type UploadedRef } from "@/lib/kyc-direct-upload";

// Every file slot on the form, in the order the server reports failures in.
const FILE_FIELDS = [
  ["photo", "Photograph"],
  ["signature", "Signature"],
  ["nidFront", "NID — front"],
  ["nidBack", "NID — back"],
  ["tinCert", "e-TIN certificate"],
  ["chequeLeafPhoto", "Cheque leaf"],
  ["nomineePhoto", "Nominee photo"],
  ["nomineeNidFront", "Nominee NID — front"],
  ["nomineeNidBack", "Nominee NID — back"],
] as const;

// Documents already uploaded are remembered across a page RELOAD, not just
// across a failed submit. A browser will not let us restore the files chosen
// in a file input, so without this an agent who reloads re-picks all nine and
// re-sends the ones already sitting in storage — which is how 658 orphaned raw
// documents accumulated. sessionStorage keeps the keys; the slots then render
// as "Already uploaded" instead of demanding the file again.
const STORE_KEY = "agent-onboarding-uploads";
// Long enough to survive a lunch break, short enough that a forgotten tab
// cannot file yesterday's documents against today's investor.
const STORE_MAX_AGE_MS = 12 * 60 * 60 * 1000;

type StoredDocs = Record<string, UploadedRef>;

function loadStoredDocs(): StoredDocs {
  try {
    const raw = sessionStorage.getItem(STORE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as { savedAt?: number; docs?: StoredDocs };
    if (!parsed?.savedAt || Date.now() - parsed.savedAt > STORE_MAX_AGE_MS) {
      sessionStorage.removeItem(STORE_KEY);
      return {};
    }
    return parsed.docs ?? {};
  } catch {
    return {};
  }
}

function saveStoredDocs(docs: StoredDocs): void {
  try {
    if (Object.keys(docs).length === 0) sessionStorage.removeItem(STORE_KEY);
    else sessionStorage.setItem(STORE_KEY, JSON.stringify({ savedAt: Date.now(), docs }));
  } catch {
    // Private mode, or quota. Uploading still works; it just will not survive
    // a reload, which is exactly where we were before.
  }
}

const INVESTOR_TYPES = [
  ["INDIVIDUAL", "Individual"],
  ["COMPANY_ORGANIZATION", "Company / Organization"],
  ["MUTUAL_FUND", "Mutual Fund"],
  ["PROVIDENT_FUND", "Provident Fund"],
  ["GRATUITY_FUND", "Gratuity Fund"],
] as const;

// The combined 4 MB cap this form used to enforce is GONE, and deliberately.
// It existed because all nine attachments went up as one multipart POST and a
// Vercel request body is capped at 4.5 MB. Documents now go straight to
// storage, one at a time, never through Vercel — so the total no longer
// matters and refusing a submission on it would be inventing a limit.
//
// What still applies is per FILE, enforced server-side in kyc-upload.ts:
// 5 MB an image, 10 MB a PDF. The running total below is shown for awareness
// only — a large scan is slow, not rejected.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function mb(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${Math.round(bytes / 1024)} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Every file currently chosen anywhere in the form, largest first. */
function attachments(form: HTMLFormElement): Array<{ name: string; size: number }> {
  const out: Array<{ name: string; size: number }> = [];
  for (const value of new FormData(form).values()) {
    if (value instanceof File && value.size > 0) {
      out.push({ name: value.name, size: value.size });
    }
  }
  return out.sort((a, b) => b.size - a.size);
}

// The API and the middleware answer some failures with a machine token
// ("unauthorized"), which is useless in front of an agent. Translate.
const MACHINE_ERRORS: Record<string, string> = {
  unauthorized:
    "Your session has ended. Sign in again at /agent/login in another tab, then submit this form again — your answers are still here.",
  forbidden:
    "This account is not allowed to submit registrations. Ask the admin to link it to your agent record.",
  auth_unavailable:
    "The sign-in service is temporarily unavailable. Wait a minute and submit again — nothing was saved.",
};

type CreateResponse = {
  ok?: boolean;
  error?: string;
  reference?: string;
  tempCode?: string;
};

// A dropped connection is the most common way this form fails, and it is
// usually transient: the agent spends minutes filling the form, the socket
// goes idle and dies, and the browser will not replay a POST body by itself.
// So resend it here. Safe to do blindly because every attempt carries the
// same submissionKey and the server keys the registration off it — a retry
// that arrives after the first one landed is answered with the SAME
// reference instead of creating a second investor.
const SEND_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [800, 2500];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Plain-language reason when the server answered without a usable JSON error. */
function describeFailure(status: number, totalBytes: number): string {
  if (status === 413) {
    return `The upload was rejected as too large (${mb(totalBytes)} of attachments). Re-save the photos as JPG and attach them again. Nothing was saved.`;
  }
  if (status === 401) return MACHINE_ERRORS.unauthorized;
  if (status === 403) return MACHINE_ERRORS.forbidden;
  if (status === 503) return MACHINE_ERRORS.auth_unavailable;
  if (status === 502 || status === 504) {
    // Only blame the attachments when they are actually heavy — this used to
    // tell agents to shrink a 400 KB upload, which sent them chasing a
    // problem they did not have.
    const heavy = totalBytes > MAX_IMAGE_BYTES;
    return `The server took too long and gave up (HTTP ${status}). Nothing was saved. ${
      heavy
        ? `The attachments come to ${mb(totalBytes)} — re-saving the photos as JPG will make this far more likely to go through.`
        : "Press “Submit for approval” again — a repeat submission cannot create the investor twice."
    }`;
  }
  return `The server answered HTTP ${status} with no reason given. Nothing was saved — please try again, and quote "HTTP ${status}" if it keeps happening.`;
}

export default function NewInvestorPage() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [doneCode, setDoneCode] = useState<string | null>(null);
  // "Connection dropped — trying again (2 of 3)…", so a slow retry does not
  // look like a frozen button.
  const [retrying, setRetrying] = useState(0);
  // Identifies THIS filling of the form across all its send attempts. Held in
  // a ref and minted on first submit: generating it during render would give
  // the server and client copies different values and break hydration, and it
  // must survive a failed attempt so the retry is recognised as the same
  // registration. Cleared by "Register another", which genuinely is a new one.
  const submissionKey = useRef<string | null>(null);
  // Documents already safely in storage, keyed by form field. Survives a
  // failed submit so a retry re-uploads only what actually failed. Cleared by
  // "Register another" — a new investor must not inherit these.
  const uploaded = useRef<StoredDocs>({});
  // A ref cannot drive rendering, and the slots must show what is already
  // stored, so the same map is mirrored into state. Written only through
  // remember/forget/clearUploads below, never directly, so the ref, the render
  // and sessionStorage can never disagree.
  const [storedDocs, setStoredDocs] = useState<StoredDocs>({});
  // "Connection dropped — retrying NID — front (2 of 3)…" while a single
  // document is being re-attempted, so a retry does not look like a freeze.
  const [uploadRetry, setUploadRetry] = useState<{ label: string; attempt: number } | null>(null);
  // "Uploading NID — front (3 of 9)…", so nine sequential uploads read as
  // progress rather than a frozen button.
  const [uploading, setUploading] = useState<{ done: number; total: number; label: string } | null>(
    null,
  );
  // Live weight of the chosen files, shown so an agent can see at a glance
  // that a 6 MB scan is about to be slow.
  const [totalBytes, setTotalBytes] = useState(0);

  // Rehydrate after mount only — reading sessionStorage during render would
  // give the server and client different HTML and break hydration.
  useEffect(() => {
    const docs = loadStoredDocs();
    if (Object.keys(docs).length > 0) {
      uploaded.current = docs;
      setStoredDocs(docs);
    }
  }, []);

  function remember(field: string, ref: UploadedRef): void {
    uploaded.current = { ...uploaded.current, [field]: ref };
    setStoredDocs(uploaded.current);
    saveStoredDocs(uploaded.current);
  }

  /** Agent wants to swap a document out — drop the stored one and show the picker again. */
  function forget(field: string): void {
    const { [field]: _dropped, ...rest } = uploaded.current;
    uploaded.current = rest;
    setStoredDocs(rest);
    saveStoredDocs(rest);
  }

  /** After a filed registration, and before a new one. One investor's
   *  documents must never carry over to the next. */
  function clearUploads(): void {
    uploaded.current = {};
    setStoredDocs({});
    saveStoredDocs({});
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const form = e.currentTarget;

    const total = attachments(form).reduce((n, f) => n + f.size, 0);

    setBusy(true);
    submissionKey.current ??= crypto.randomUUID();

    // 1. Files first, each straight to storage, and each on its own.
    //
    // Uploads already done in an earlier attempt are kept in `uploaded` and
    // skipped, so pressing Submit again after a failure only re-sends what
    // actually failed — the agent never re-uploads eight good files because
    // the ninth dropped.
    const fd = new FormData(form);
    const pending = FILE_FIELDS.filter(([field]) => {
      const f = fd.get(field);
      return f instanceof File && f.size > 0 && !uploaded.current[field];
    });

    for (let i = 0; i < pending.length; i++) {
      const [field, label] = pending[i];
      const file = fd.get(field) as File;
      setUploading({ done: i, total: pending.length, label });
      try {
        remember(
          field,
          await uploadKycDocument(file, (attempt) => setUploadRetry({ label, attempt })),
        );
        setUploadRetry(null);
      } catch (err) {
        setUploading(null);
        setUploadRetry(null);
        setBusy(false);
        // Say how many are genuinely stored. The old text claimed uploads were
        // "remembered" even when the very first one had failed and there were
        // none, which read as though work had been saved when it had not.
        const stored = Object.keys(uploaded.current).length;
        setError(
          `${label} could not be uploaded (${
            err instanceof Error ? err.message : "upload failed"
          }). Nothing was saved. ${
            stored > 0
              ? `${stored} of ${FILE_FIELDS.length} documents are already stored and will not be sent again — press “Submit for approval” to retry only what is left.`
              : `No documents got through, so this is the connection rather than the file — check you are online and press “Submit for approval” again. This slot is simply the first in the queue, not the problem.`
          }`,
        );
        return;
      }
    }
    setUploading(null);

    // 2. Then the registration itself — JSON, a couple of kilobytes, carrying
    //    only the storage keys. This is the request that used to be nine files
    //    wide and is now small enough that a retry is nearly free.
    const payload: Record<string, unknown> = { submissionKey: submissionKey.current };
    for (const [k, v] of fd.entries()) {
      if (typeof v === "string") payload[k] = v;
    }
    payload.documents = uploaded.current;

    let res: Response | null = null;
    let lastNetworkError = "";
    for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt++) {
      try {
        res = await fetch("/api/agent/investors/create", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        break;
      } catch (err) {
        lastNetworkError = err instanceof Error ? err.message : "network error";
        if (attempt === SEND_ATTEMPTS) break;
        setRetrying(attempt + 1);
        await sleep(RETRY_BACKOFF_MS[attempt - 1] ?? 2500);
      }
    }
    setRetrying(0);

    if (!res) {
      // The old code awaited this fetch unguarded, so a dropped upload left
      // `busy` true: the button said "Submitting…" for ever and printed
      // nothing. Never leave the agent without an answer.
      setBusy(false);
      setError(
        `The registration could not be sent — the connection dropped before the server answered, ${SEND_ATTEMPTS} times in a row (${lastNetworkError}). Nothing was saved and nothing was lost: your answers and files are all still on this page. Check you are online and press “Submit for approval” again — a repeat submission cannot create the investor twice.`,
      );
      return;
    }

    // Read the body as text first. A rejected upload, a gateway timeout and a
    // signed-out redirect all answer with HTML, and `res.json()` on those threw
    // the status away — the one thing that says WHAT went wrong.
    const raw = await res.text().catch(() => "");
    let data: CreateResponse | null = null;
    try {
      data = JSON.parse(raw) as CreateResponse;
    } catch {
      // Not JSON — describeFailure() below explains it from the status.
    }
    setBusy(false);

    if (!res.ok || !data?.ok) {
      const reported = data?.error;
      setError(
        (reported && MACHINE_ERRORS[reported]) ??
          reported ??
          describeFailure(res.status, total),
      );
      return;
    }
    // Prefer the bare reference (S00001-260806-K3F9); fall back to the temp
    // code for a server that predates it.
    // Filed. These documents now belong to a real registration; keeping the
    // keys would let a reload attach them to somebody else.
    clearUploads();
    setDoneCode(data.reference ?? data.tempCode ?? "");
  }

  if (doneCode !== null) {
    return (
      <main className="min-h-screen bg-emerald-50/30 px-6 py-16 dark:bg-emerald-950/30">
        <div className="mx-auto max-w-lg rounded-lg border border-emerald-300 bg-white p-6 dark:border-emerald-800 dark:bg-zinc-900">
          <h1 className="text-xl font-semibold text-emerald-800 dark:text-emerald-300">Registration submitted ✓</h1>
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
            The investor is now <strong>pending admin approval</strong>. It appears on the admin
            dashboard tagged with your agent code. The admin will assign the investor code and
            send the welcome email.
          </p>

          {/* The reference was previously captured and then never shown, so the
              agent had nothing to quote when following the form up. */}
          {doneCode ? (
            <div className="mt-4 rounded-md border border-emerald-300 bg-emerald-50 px-4 py-3 dark:border-emerald-800 dark:bg-emerald-950/40">
              <div className="text-[11px] uppercase tracking-wider text-emerald-800 dark:text-emerald-400">
                Reference number
              </div>
              <div className="mt-0.5 font-mono text-lg font-semibold text-emerald-900 dark:text-emerald-200">
                {doneCode}
              </div>
              <p className="mt-1 text-xs text-emerald-800/80 dark:text-emerald-300/80">
                Quote this when you follow the registration up. Accounts can see it against the
                pending registration, so they know the form came from you.
              </p>
            </div>
          ) : null}
          <div className="mt-5 flex gap-3">
            <button
              onClick={() => {
                // A genuinely new registration, so it needs its own key —
                // reusing this one would be answered as a replay of the
                // registration just filed.
                submissionKey.current = null;
                // The next investor's documents are their own — carrying these
                // over would file one person's NID against another.
                clearUploads();
                setDoneCode(null);
                router.refresh();
              }}
              className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800"
            >
              Register another
            </button>
            <Link href="/agent" className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 dark:border-zinc-700 dark:text-zinc-300">
              Back to dashboard
            </Link>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-emerald-50/30 px-6 py-10 dark:bg-emerald-950/30">
      <div className="mx-auto max-w-2xl">
        <div className="text-xs uppercase tracking-widest text-zinc-500">
          <Link href="/agent" className="hover:text-zinc-700 dark:hover:text-zinc-300">← Dashboard</Link>
        </div>
        <h1 className="mt-2 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">Onboard an investor</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Fill the investor&apos;s details and upload their documents. On submit it goes to the
          admin for approval — you don&apos;t set the investor code or send the welcome email.
        </p>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          Each document is uploaded on its own as you submit, so one weak moment on the network
          costs a single file rather than the whole form. Photograph the documents or save them as
          <strong> JPG</strong> — a PNG screenshot of an NID is 3–5 MB on
          its own and will not go through.
        </p>

        {/* onChange is form-level so every FileField is covered without
            threading a callback through each one. Typing in a text field
            bubbles here too, so only recount when a file slot changed. */}
        <form
          onSubmit={onSubmit}
          onChange={(e) => {
            if ((e.target as HTMLInputElement).type !== "file") return;
            setTotalBytes(attachments(e.currentTarget).reduce((n, f) => n + f.size, 0));
          }}
          className="mt-6 space-y-6"
        >
          <Section title="Identity">
            <Field name="name" label="Full name" required />
            <Select name="investorType" label="Investor type" options={INVESTOR_TYPES} />
            <Field name="dateOfBirth" label="Date of birth" type="date" />
            <Field name="nidNumber" label="NID number" />
            <Field name="tinNumber" label="e-TIN" />
            <Field name="fatherName" label="Father's name" />
            <Field name="motherName" label="Mother's name" />
            <Select name="dividendOption" label="Dividend option" options={[["CASH", "Cash"], ["CIP", "CIP"]]} />
          </Section>

          <Section title="Contact">
            <Field name="email" label="Email" type="email" required />
            <Field name="phone" label="Phone" />
            <Field name="presentAddress" label="Present address" full />
            <Field name="permanentAddress" label="Permanent address" full />
          </Section>

          <Section title="Documents">
            <FileField name="photo" label="Photograph (passport size)" uploadedName={storedDocs["photo"]?.name} onReplace={() => forget("photo")} />
            <FileField name="signature" label="Signature" uploadedName={storedDocs["signature"]?.name} onReplace={() => forget("signature")} />
            <FileField name="nidFront" label="NID — front" uploadedName={storedDocs["nidFront"]?.name} onReplace={() => forget("nidFront")} />
            <FileField name="nidBack" label="NID — back" uploadedName={storedDocs["nidBack"]?.name} onReplace={() => forget("nidBack")} />
            <FileField name="tinCert" label="e-TIN certificate (image or PDF)" uploadedName={storedDocs["tinCert"]?.name} onReplace={() => forget("tinCert")} />
          </Section>

          <Section title="Bank account (optional)">
            <Field name="bankName" label="Bank name" />
            <Field name="branchName" label="Branch" />
            <Field name="accountNumber" label="Account number" />
            <Field name="routingNumber" label="Routing number" />
            <FileField name="chequeLeafPhoto" label="Cheque leaf (image or PDF)" uploadedName={storedDocs["chequeLeafPhoto"]?.name} onReplace={() => forget("chequeLeafPhoto")} />
          </Section>

          <Section title="Nominee (optional)">
            <Field name="nomineeName" label="Nominee name" />
            <Field name="nomineeRelationship" label="Relationship" />
            <Field name="nomineeNidNumber" label="Nominee NID" />
            <FileField name="nomineePhoto" label="Nominee photo" uploadedName={storedDocs["nomineePhoto"]?.name} onReplace={() => forget("nomineePhoto")} />
            <FileField name="nomineeNidFront" label="Nominee NID — front" uploadedName={storedDocs["nomineeNidFront"]?.name} onReplace={() => forget("nomineeNidFront")} />
            <FileField name="nomineeNidBack" label="Nominee NID — back" uploadedName={storedDocs["nomineeNidBack"]?.name} onReplace={() => forget("nomineeNidBack")} />
          </Section>

          {totalBytes > 0 && (
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Attachments: {mb(totalBytes)} across {FILE_FIELDS.length} slots. Large photos are
              shrunk in your browser before they are sent.
            </p>
          )}

          {uploading && (
            <p
              role="status"
              className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200"
            >
              Uploading {uploading.label} ({uploading.done + 1} of {uploading.total})… Each document
              is sent on its own, so a dropped connection only costs this one.
            </p>
          )}

          {uploadRetry && (
            <p
              role="status"
              className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
            >
              The connection dropped while sending {uploadRetry.label}. Trying that document again
              — attempt {uploadRetry.attempt} of {UPLOAD_ATTEMPTS}. Everything already uploaded is
              safe. Stay on this page.
            </p>
          )}

          {retrying > 0 && (
            <p
              role="status"
              className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
            >
              The connection dropped. Sending again — attempt {retrying} of {SEND_ATTEMPTS}. Stay on
              this page.
            </p>
          )}

          {error && (
            <p
              role="alert"
              className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
            >
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-emerald-700 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-60"
          >
            {uploading
              ? `Uploading ${uploading.done + 1}/${uploading.total}…`
              : retrying > 0
                ? `Retrying (${retrying}/${SEND_ATTEMPTS})…`
                : busy
                  ? "Submitting…"
                  : "Submit for approval"}
          </button>
        </form>
      </div>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-500">{title}</h2>
      <div className="grid grid-cols-1 gap-3 rounded-lg border border-zinc-200 bg-white p-4 sm:grid-cols-2 dark:border-zinc-800 dark:bg-zinc-900">
        {children}
      </div>
    </section>
  );
}

function Field({
  name, label, type = "text", required = false, full = false,
}: {
  name: string; label: string; type?: string; required?: boolean; full?: boolean;
}) {
  return (
    <label className={`block text-sm ${full ? "sm:col-span-2" : ""}`}>
      <span className="mb-1 block text-zinc-600 dark:text-zinc-400">
        {label} {required && <span className="text-red-500">*</span>}
      </span>
      <input
        name={name}
        type={type}
        required={required}
        className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 dark:border-zinc-700 dark:bg-zinc-950"
      />
    </label>
  );
}

function Select({
  name, label, options,
}: {
  name: string; label: string; options: ReadonlyArray<readonly [string, string]>;
}) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-zinc-600 dark:text-zinc-400">{label}</span>
      {/* The dark styling has to reach the options as well. Chrome paints the
          popup list from the option's own colours, so a dark select with bare
          options renders near-white text on the default white — the list looks
          empty and there is no visible way to pick CIP over Cash. color-scheme
          tells the browser to draw the native chrome dark to match. */}
      <select
        name={name}
        className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:[color-scheme:dark]"
      >
        {options.map(([v, l]) => (
          <option key={v} value={v} className="bg-white text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100">
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}

function FileField({
  name,
  label,
  uploadedName,
  onReplace,
}: {
  name: string;
  label: string;
  /** Set when this document is already in storage from an earlier attempt. */
  uploadedName?: string;
  onReplace?: () => void;
}) {
  // Already stored: show it as done rather than an empty picker. A browser
  // cannot repopulate a file input after a reload, so an empty box here would
  // tell the agent to find and send the file a second time when it is already
  // safely uploaded.
  if (uploadedName) {
    return (
      <div className="block text-sm">
        <span className="mb-1 block text-zinc-600 dark:text-zinc-400">{label}</span>
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-emerald-300 bg-emerald-50 px-2 py-1.5 text-xs text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
          <span className="truncate">Uploaded &#10003; {uploadedName}</span>
          <button type="button" onClick={onReplace} className="shrink-0 underline">
            Replace
          </button>
        </div>
      </div>
    );
  }
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-zinc-600 dark:text-zinc-400">{label}</span>
      <input
        name={name}
        type="file"
        accept="image/jpeg,image/png,image/webp,application/pdf"
        className="w-full text-xs text-zinc-600 file:mr-3 file:rounded file:border-0 file:bg-emerald-100 file:px-3 file:py-1.5 file:text-emerald-800 dark:text-zinc-400 dark:file:bg-emerald-950 dark:file:text-emerald-200"
      />
    </label>
  );
}
