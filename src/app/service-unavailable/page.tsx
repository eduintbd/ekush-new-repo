import Link from "next/link";
import { RetryButton } from "./retry-button";

// Shown when Supabase Auth (GoTrue) is unreachable. The middleware rewrites
// gated routes here with a 503 instead of holding the request open until the
// gateway times out and serves a "Gateway time-out 504" — which readers
// understand as "my login is broken" (2026-08-28 incident).
//
// Public route (see isPublic in src/middleware.ts) and it reads nothing:
// during an auth outage we cannot identify anyone anyway.
export const metadata = { title: "Temporarily unavailable — Ekush ERP" };

export const dynamic = "force-dynamic";

export default function ServiceUnavailablePage() {
  return (
    <main className="min-h-screen bg-gradient-to-br from-amber-50 via-zinc-50 to-amber-50 px-6 py-16 dark:from-zinc-950 dark:via-zinc-950 dark:to-amber-950">
      <div className="mx-auto max-w-md">
        <Link
          href="/"
          className="text-xs uppercase tracking-widest text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
        >
          ← Ekush ERP
        </Link>

        <div className="mt-3 inline-flex items-center gap-2 rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-800 dark:bg-amber-900 dark:text-amber-200">
          Service notice
        </div>

        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Sign-in is temporarily unavailable
        </h1>

        <p className="mt-3 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
          The authentication service isn&apos;t responding right now. This is a
          problem on our side —{" "}
          <span className="font-medium text-zinc-800 dark:text-zinc-200">
            your account and your password are fine
          </span>
          , and no data has been affected. Please try again in a few minutes.
        </p>

        <p className="mt-3 text-xs leading-relaxed text-zinc-500">
          If this persists, check the Supabase project&apos;s Auth service — the
          investor portal shares the same project and will be affected too.
        </p>

        <div className="mt-8 space-y-3">
          <RetryButton />
          <div className="flex items-center justify-center gap-4 text-sm">
            <Link
              href="/login"
              className="text-zinc-600 underline-offset-2 hover:underline dark:text-zinc-400"
            >
              Staff sign-in
            </Link>
            <span className="text-zinc-400">·</span>
            <Link
              href="/agent/login"
              className="text-zinc-600 underline-offset-2 hover:underline dark:text-zinc-400"
            >
              Agent sign-in
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
