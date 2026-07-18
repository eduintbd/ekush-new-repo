"use client";

import { useState } from "react";
import { raiseTicket } from "./actions";

const REQUEST_TYPES: { value: string; label: string }[] = [
  { value: "BANK_CHANGE", label: "Bank account change" },
  { value: "ADDRESS_CHANGE", label: "Address change" },
  { value: "PHONE_CHANGE", label: "Phone change" },
  { value: "EMAIL_CHANGE", label: "Email change" },
  { value: "NID_CHANGE", label: "NID correction" },
  { value: "NOMINEE_CHANGE", label: "Nominee change" },
  { value: "NAME_CORRECTION", label: "Name correction" },
  { value: "UNIT_CERT_REISSUE", label: "Unit certificate re-issue" },
  { value: "GENERAL_INQUIRY", label: "General inquiry" },
  { value: "COMPLAINT", label: "Complaint" },
];

export default function RaiseTicketForm({ code }: { code: string }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const res = await raiseTicket(new FormData(e.currentTarget));
    setBusy(false);
    setMsg({ ok: res.ok, text: res.ok ? res.message ?? "Submitted." : res.error ?? "Failed." });
    if (res.ok) e.currentTarget.reset();
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <input type="hidden" name="code" value={code} />
      <p className="text-xs text-zinc-500">
        You cannot edit an approved investor&apos;s details. Raise a request and the
        office will action it — it shows on the admin dashboard as sent by you.
      </p>
      <label className="block text-sm">
        <span className="mb-1 block text-zinc-600 dark:text-zinc-400">Request type</span>
        <select
          name="type"
          className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
        >
          {REQUEST_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-zinc-600 dark:text-zinc-400">Details</span>
        <textarea
          name="description"
          required
          rows={3}
          placeholder="Describe the change or request…"
          className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
        />
      </label>
      {msg && (
        <p className={`text-sm ${msg.ok ? "text-emerald-700 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
          {msg.text}
        </p>
      )}
      <button
        type="submit"
        disabled={busy}
        className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-60"
      >
        {busy ? "Submitting…" : "Submit request"}
      </button>
    </form>
  );
}
