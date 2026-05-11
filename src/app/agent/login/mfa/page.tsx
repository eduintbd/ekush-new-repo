// /agent/login/mfa — TOTP challenge for selling agents who have enrolled
// a factor. MFA is optional for the agent role; this page is only
// reached if requireAgent detects an enrolled factor and the session
// has not yet stepped up to AAL2.

import Link from "next/link";
import { adminClientAvailable } from "@/lib/supabase/admin";
import { verifyChallenge, signOutFromChallenge } from "@/app/login/mfa/actions";

type Search = { next?: string; error?: string };

export const metadata = { title: "Verify two-factor — Ekush Agent Portal" };

export default async function AgentMfaChallengePage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const sp = await searchParams;
  const recoveryEnabled = adminClientAvailable();
  return (
    <main className="min-h-screen bg-gradient-to-br from-emerald-50 via-zinc-50 to-emerald-50 px-6 py-16 dark:from-emerald-950 dark:via-zinc-950 dark:to-emerald-950">
      <div className="mx-auto max-w-md">
        <div className="inline-flex items-center gap-2 rounded-full bg-emerald-100 px-3 py-1 text-xs font-medium text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200">
          Selling agent portal
        </div>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Verify your two-factor code
        </h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          Open your authenticator app and enter the 6-digit code for Ekush ERP.
        </p>

        <form action={verifyChallenge} className="mt-8 space-y-4">
          <input type="hidden" name="portal" value="agent" />
          <input type="hidden" name="next" value={sp.next ?? "/agent"} />
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wider text-zinc-600 dark:text-zinc-400">
              6-digit code
            </span>
            <input
              type="text"
              name="code"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              autoComplete="one-time-code"
              required
              autoFocus
              className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-center font-mono text-xl tracking-widest focus:border-emerald-700 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:focus:border-emerald-400"
            />
          </label>

          {sp.error && <p className="text-sm text-red-600 dark:text-red-400">{sp.error}</p>}

          <button
            type="submit"
            className="mt-2 w-full rounded-md bg-emerald-700 py-2.5 text-sm font-medium text-white hover:bg-emerald-800 dark:bg-emerald-600 dark:hover:bg-emerald-500"
          >
            Verify
          </button>
        </form>

        {recoveryEnabled && (
          <p className="mt-6 text-xs text-zinc-500">
            <Link
              href="/login/mfa/recovery?portal=agent"
              className="underline hover:text-zinc-700 dark:hover:text-zinc-300"
            >
              Lost your authenticator? Use a recovery code →
            </Link>
          </p>
        )}

        <form action={signOutFromChallenge} className="mt-6">
          <button
            type="submit"
            className="text-xs text-zinc-500 underline hover:text-zinc-700 dark:hover:text-zinc-300"
          >
            Sign out and start over
          </button>
        </form>
      </div>
    </main>
  );
}
