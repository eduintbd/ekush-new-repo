// /login/mfa — TOTP challenge after a successful password sign-in.
// Required for admin + accountant; also reached by anyone who has a
// verified factor and lands here from the sign-in action.

import Link from "next/link";
import { adminClientAvailable } from "@/lib/supabase/admin";
import { verifyChallenge, signOutFromChallenge } from "./actions";

type Search = { next?: string; error?: string };

export const metadata = { title: "Verify two-factor — Ekush ERP" };

export default async function StaffMfaChallengePage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const sp = await searchParams;
  const recoveryEnabled = adminClientAvailable();
  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-16 dark:bg-zinc-950">
      <div className="mx-auto max-w-md">
        <p className="text-xs uppercase tracking-widest text-zinc-500">Staff portal</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Verify your two-factor code
        </h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          Open your authenticator app and enter the 6-digit code for Ekush ERP.
        </p>

        <form action={verifyChallenge} className="mt-8 space-y-4">
          <input type="hidden" name="portal" value="staff" />
          <input type="hidden" name="next" value={sp.next ?? "/dashboard"} />
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
              className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-center font-mono text-xl tracking-widest focus:border-zinc-900 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:focus:border-zinc-100"
            />
          </label>

          {sp.error && <p className="text-sm text-red-600 dark:text-red-400">{sp.error}</p>}

          <button
            type="submit"
            className="mt-2 w-full rounded-md bg-zinc-900 py-2.5 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            Verify
          </button>
        </form>

        {recoveryEnabled && (
          <p className="mt-6 text-xs text-zinc-500">
            <Link
              href="/login/mfa/recovery?portal=staff"
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
