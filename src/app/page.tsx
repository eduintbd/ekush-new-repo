// / — public landing for x.ekushwml.com. Same staff use BOTH Ekush
// Portal (investor management, portal.ekushwml.com) AND X-System (this
// app — back-office accounting + agent commissions). Show both options
// so users can pick where they're going. Same credentials work on either.

import Link from "next/link";
import RecoveryHashRedirect from "./RecoveryHashRedirect";

const PORTAL_URL = process.env.NEXT_PUBLIC_EKUSH_PORTAL_URL ?? "https://portal.ekushwml.com";

export default function Home() {
  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-16 dark:bg-zinc-950">
      <RecoveryHashRedirect />
      <div className="mx-auto w-full max-w-3xl">
        <div className="mb-10">
          <p className="text-sm font-medium uppercase tracking-widest text-zinc-500">
            Ekush Wealth Management Limited
          </p>
          <h1 className="mt-2 text-4xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            Internal systems
          </h1>
          <p className="mt-4 text-base leading-7 text-zinc-600 dark:text-zinc-400">
            Pick the system you're signing in to. Your email + password is the same
            on both — each subdomain holds its own session, so you'll sign in once
            per system.
          </p>
        </div>

        {/* Top-level: the two systems */}
        <div className="grid gap-4 sm:grid-cols-2">
          {/* Ekush Portal (external) */}
          <a
            href={`${PORTAL_URL}/login`}
            className="group rounded-lg border border-zinc-200 bg-white p-6 transition-colors hover:border-zinc-400 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-600 dark:hover:bg-zinc-800"
          >
            <p className="text-[11px] font-semibold uppercase tracking-widest text-amber-700 dark:text-amber-400">
              External · portal.ekushwml.com
            </p>
            <p className="mt-2 text-xl font-semibold text-zinc-900 dark:text-zinc-50">
              Ekush Portal
              <span className="ml-1 text-zinc-400 group-hover:text-zinc-700 dark:group-hover:text-zinc-300">
                ↗
              </span>
            </p>
            <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
              Investor management, fund uploads, daily NAV, KYC, content / CMS.
            </p>
            <p className="mt-4 text-xs text-zinc-500">
              For portal SUPER_ADMIN / ADMIN / CHECKER / MAKER roles.
            </p>
          </a>

          {/* X-System (internal — this app) */}
          <Link
            href="/login"
            className="group rounded-lg border-2 border-zinc-900 bg-white p-6 transition-colors hover:bg-zinc-50 dark:border-zinc-100 dark:bg-zinc-900 dark:hover:bg-zinc-800"
          >
            <p className="text-[11px] font-semibold uppercase tracking-widest text-emerald-700 dark:text-emerald-400">
              Internal · x.ekushwml.com
            </p>
            <p className="mt-2 text-xl font-semibold text-zinc-900 dark:text-zinc-50">
              X-System →
            </p>
            <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
              Back-office accounting, journals, financial statements, year-end
              workbook, selling-agent commission engine.
            </p>
            <p className="mt-4 text-xs text-zinc-500">
              For AMC admin / accountant / auditor / selling agent roles.
            </p>
          </Link>
        </div>

        {/* Sub-options inside X-System */}
        <div className="mt-8 rounded-lg border border-zinc-200 bg-zinc-100 px-5 py-4 text-sm dark:border-zinc-800 dark:bg-zinc-900/60">
          <p className="text-[11px] font-semibold uppercase tracking-widest text-zinc-500">
            Within X-System
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-zinc-700 dark:text-zinc-300">
            <Link href="/login" className="font-medium underline-offset-2 hover:underline">
              Staff sign-in
            </Link>
            <span className="text-zinc-400">·</span>
            <Link href="/agent/login" className="font-medium underline-offset-2 hover:underline">
              Selling-agent sign-in
            </Link>
            <span className="text-zinc-400">·</span>
            <Link href="/account/mfa" className="font-medium underline-offset-2 hover:underline">
              MFA / security
            </Link>
          </div>
        </div>

        <p className="mt-10 text-xs leading-relaxed text-zinc-500">
          Two-factor authentication is required for admin + accountant roles in X-System;
          optional but encouraged for auditor + selling-agent. Same authenticator app entry
          can be reused only if you generate from this system's MFA setup screen — Ekush
          Portal MFA (if any) is separate.
        </p>
      </div>
    </main>
  );
}
