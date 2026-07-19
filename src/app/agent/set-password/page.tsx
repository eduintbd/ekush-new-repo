"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createBrowserClient } from "@supabase/ssr";
import { validatePassword } from "@/lib/password-rules";

type Stage = "loading" | "ready" | "invalid" | "done";

// Landing page for the emailed set-password / recovery link. An admin-generated
// recovery/invite link (auth.admin.generateLink) is a NON-PKCE link, so Supabase
// redirects here with the session in the URL HASH (#access_token&refresh_token).
// We disable the client's auto URL detection and establish the session
// explicitly from the hash (or a ?code= for the PKCE case), which is far more
// reliable than relying on detectSessionInUrl.
export default function AgentSetPasswordPage() {
  const supabase = useMemo(
    () =>
      createBrowserClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        { auth: { detectSessionInUrl: false } },
      ),
    [],
  );
  const [stage, setStage] = useState<Stage>("loading");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Capture the hash + query synchronously before anything can clear them.
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const query = new URLSearchParams(window.location.search);
    const errorDesc = hash.get("error_description") || hash.get("error") || query.get("error");
    const accessToken = hash.get("access_token");
    const refreshToken = hash.get("refresh_token");
    const code = query.get("code");

    async function establish() {
      if (errorDesc) return setStage("invalid");

      if (accessToken && refreshToken) {
        const { error } = await supabase.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken,
        });
        // Tidy the URL so the tokens aren't left in the address bar / history.
        window.history.replaceState(null, "", window.location.pathname);
        return setStage(error ? "invalid" : "ready");
      }

      if (code) {
        const { error } = await supabase.auth.exchangeCodeForSession(code);
        return setStage(error ? "invalid" : "ready");
      }

      // Fallback: maybe a session already exists.
      const { data } = await supabase.auth.getSession();
      setStage(data.session ? "ready" : "invalid");
    }

    establish();
  }, [supabase]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const check = validatePassword(password);
    if (!check.ok) return setError(check.reason);
    if (password !== confirm) return setError("Passwords do not match.");
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (error) return setError(error.message);
    // Sign out so the agent logs in fresh with their new password.
    await supabase.auth.signOut();
    setStage("done");
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-50 px-6 dark:bg-zinc-950">
      <div className="w-full max-w-sm">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">Set your password</h1>

        {stage === "loading" && (
          <p className="mt-4 text-sm text-zinc-600 dark:text-zinc-400">Verifying your link…</p>
        )}

        {stage === "invalid" && (
          <div className="mt-4 space-y-3">
            <p className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
              This link is invalid or has expired. Request a fresh one below.
            </p>
            <Link
              href="/agent/forgot-password"
              className="inline-block rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800"
            >
              Request a new link
            </Link>
            <Link href="/agent/login" className="block text-sm text-zinc-700 underline dark:text-zinc-300">
              Back to sign in
            </Link>
          </div>
        )}

        {stage === "ready" && (
          <form onSubmit={onSubmit} className="mt-6 space-y-3">
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              At least 10 characters, with an uppercase and lowercase letter, a digit, and a symbol.
            </p>
            <input
              type="password"
              required
              placeholder="New password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
            <input
              type="password"
              required
              placeholder="Confirm password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
            {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-md bg-zinc-900 py-2.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900"
            >
              {busy ? "Saving…" : "Set password"}
            </button>
          </form>
        )}

        {stage === "done" && (
          <div className="mt-6 space-y-3">
            <p className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
              Password set. You can now sign in.
            </p>
            <Link
              href="/agent/login"
              className="inline-block rounded-md bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
            >
              Go to sign in
            </Link>
          </div>
        )}
      </div>
    </main>
  );
}
