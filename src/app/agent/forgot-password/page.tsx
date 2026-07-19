"use client";

import { useState } from "react";
import Link from "next/link";
import { requestAgentReset } from "./actions";

export default function AgentForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    await requestAgentReset(email);
    setBusy(false);
    setSent(true);
  }

  return (
    <main className="min-h-screen bg-gradient-to-br from-emerald-50 via-zinc-50 to-emerald-50 px-6 py-16 dark:from-emerald-950 dark:via-zinc-950 dark:to-emerald-950">
      <div className="mx-auto max-w-md">
        <Link href="/agent/login" className="text-xs uppercase tracking-widest text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
          ← Agent sign-in
        </Link>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Forgot password
        </h1>

        {sent ? (
          <p className="mt-6 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-3 text-sm text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
            If that email belongs to an agent account, a set-password link is on its way.
            The link is valid for a limited time — open it and choose a new password.
          </p>
        ) : (
          <form onSubmit={onSubmit} className="mt-8 space-y-4">
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Enter your email and we&apos;ll send you a link to set a new password.
            </p>
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wider text-zinc-600 dark:text-zinc-400">
                Email
              </span>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-emerald-700 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900"
              />
            </label>
            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-md bg-emerald-700 py-2.5 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-60"
            >
              {busy ? "Sending…" : "Send reset link"}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
