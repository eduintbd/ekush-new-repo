"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

const INVESTOR_TYPES = [
  ["INDIVIDUAL", "Individual"],
  ["COMPANY_ORGANIZATION", "Company / Organization"],
  ["MUTUAL_FUND", "Mutual Fund"],
  ["PROVIDENT_FUND", "Provident Fund"],
  ["GRATUITY_FUND", "Gratuity Fund"],
] as const;

export default function NewInvestorPage() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [doneCode, setDoneCode] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/agent/investors/create", {
      method: "POST",
      body: new FormData(e.currentTarget),
    });
    const data = await res.json().catch(() => ({ ok: false, error: "Unexpected response." }));
    setBusy(false);
    if (!res.ok || !data.ok) {
      setError(data.error ?? "Could not submit the registration.");
      return;
    }
    // Prefer the bare reference (S00001-260806-K3F9); fall back to the temp
    // code for a server that predates it.
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
              onClick={() => { setDoneCode(null); router.refresh(); }}
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

        <form onSubmit={onSubmit} className="mt-6 space-y-6">
          <Section title="Identity">
            <Field name="name" label="Full name" required />
            <Select name="investorType" label="Investor type" options={INVESTOR_TYPES} />
            <Field name="dateOfBirth" label="Date of birth" type="date" />
            <Field name="nidNumber" label="NID number" />
            <Field name="tinNumber" label="e-TIN" />
            <Field name="fatherName" label="Father's name" />
            <Field name="motherName" label="Mother's name" />
            <Select name="dividendOption" label="Dividend option" options={[["CASH", "Cash"], ["CIP", "Reinvest (CIP)"]]} />
          </Section>

          <Section title="Contact">
            <Field name="email" label="Email" type="email" required />
            <Field name="phone" label="Phone" />
            <Field name="presentAddress" label="Present address" full />
            <Field name="permanentAddress" label="Permanent address" full />
          </Section>

          <Section title="Documents">
            <FileField name="photo" label="Photograph (passport size)" />
            <FileField name="signature" label="Signature" />
            <FileField name="nidFront" label="NID — front" />
            <FileField name="nidBack" label="NID — back" />
            <FileField name="tinCert" label="e-TIN certificate (image or PDF)" />
          </Section>

          <Section title="Bank account (optional)">
            <Field name="bankName" label="Bank name" />
            <Field name="branchName" label="Branch" />
            <Field name="accountNumber" label="Account number" />
            <Field name="routingNumber" label="Routing number" />
            <FileField name="chequeLeafPhoto" label="Cheque leaf (image or PDF)" />
          </Section>

          <Section title="Nominee (optional)">
            <Field name="nomineeName" label="Nominee name" />
            <Field name="nomineeRelationship" label="Relationship" />
            <Field name="nomineeNidNumber" label="Nominee NID" />
            <FileField name="nomineePhoto" label="Nominee photo" />
            <FileField name="nomineeNidFront" label="Nominee NID — front" />
            <FileField name="nomineeNidBack" label="Nominee NID — back" />
          </Section>

          {error && (
            <p className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-emerald-700 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-60"
          >
            {busy ? "Submitting…" : "Submit for approval"}
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
      <select
        name={name}
        className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 dark:border-zinc-700 dark:bg-zinc-950"
      >
        {options.map(([v, l]) => (
          <option key={v} value={v}>{l}</option>
        ))}
      </select>
    </label>
  );
}

function FileField({ name, label }: { name: string; label: string }) {
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
