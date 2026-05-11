// /login/mfa/recovery — fall-back when a user can't reach their
// authenticator. They enter one of their recovery codes; on match the
// server clears every MFA factor on their account, signs them out, and
// they re-enrol on next sign-in.
//
// Both staff and agent portals route here via /login/mfa and
// /agent/login/mfa "Lost your authenticator?" links — the `portal`
// hidden field disambiguates.

import Link from "next/link";
import { verifyRecoveryCode } from "./actions";

type Search = { portal?: "staff" | "agent"; error?: string };

export const metadata = { title: "Use recovery code — Ekush ERP" };

export default async function RecoveryPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const sp = await searchParams;
  const portal = sp.portal === "agent" ? "agent" : "staff";
  const challengeHref = portal === "agent" ? "/agent/login/mfa" : "/login/mfa";

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-16 dark:bg-zinc-950">
      <div className="mx-auto max-w-md">
        <p className="text-xs uppercase tracking-widest text-zinc-500">
          {portal === "agent" ? "Selling agent" : "Staff portal"}
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Use a recovery code
        </h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          Enter one of the recovery codes you saved when you enrolled. Each code works once and your authenticator factor will be removed — you&apos;ll enrol a new one after signing in.
        </p>

        <form action={verifyRecoveryCode} className="mt-8 space-y-4">
          <input type="hidden" name="portal" value={portal} />
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wider text-zinc-600 dark:text-zinc-400">
              Recovery code
            </span>
            <input
              type="text"
              name="code"
              placeholder="XXXX-XXXX-XXXX"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              required
              autoFocus
              className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-center font-mono text-base tracking-widest focus:border-zinc-900 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:focus:border-zinc-100"
            />
          </label>

          {sp.error && <p className="text-sm text-red-600 dark:text-red-400">{sp.error}</p>}

          <button
            type="submit"
            className="mt-2 w-full rounded-md bg-zinc-900 py-2.5 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            Submit recovery code
          </button>
        </form>

        <p className="mt-6 text-xs text-zinc-500">
          <Link href={challengeHref} className="underline hover:text-zinc-700 dark:hover:text-zinc-300">
            ← Back to authenticator code
          </Link>
        </p>
      </div>
    </main>
  );
}
