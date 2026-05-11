// /account/mfa — MFA management. Any signed-in user can enrol and manage
// TOTP factors here. Admin + accountant are forced into this page on
// first sign-in until they enrol a factor (see requireStaff).

import Link from "next/link";
import { requireAuthenticated } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getMfaStatus, mfaRequiredForRole, countActiveRecoveryCodes } from "@/lib/mfa";
import { adminClientAvailable } from "@/lib/supabase/admin";
import { unenrol } from "./actions";
import { EnrolFlow } from "./enrol-flow";
import { RecoveryCodesSection } from "./recovery-codes-section";

type Search = { reason?: string; ok?: string; error?: string };

export const metadata = { title: "Security — Ekush ERP" };

export default async function MfaPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const profile = await requireAuthenticated();
  const sp = await searchParams;

  const supabase = await createSupabaseServerClient();
  const status = await getMfaStatus(supabase);
  const required = mfaRequiredForRole(profile.role);
  const requiredAndMissing =
    required && status.verifiedFactors.length === 0;
  const recoveryCount = status.verifiedFactors.length > 0 ? await countActiveRecoveryCodes(profile.id) : 0;
  const recoveryAvailable = adminClientAvailable();

  return (
    <main className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <div className="mx-auto max-w-2xl px-6 py-12">
        <Link href="/dashboard" className="text-xs uppercase tracking-widest text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
          ← Dashboard
        </Link>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Two-factor authentication
        </h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          Adds a TOTP code (Google Authenticator, 1Password, Authy, …) on top of your password.
          {required && (
            <>
              {" "}
              <strong>Required</strong> for your role ({profile.role}).
            </>
          )}
        </p>

        {sp.reason === "required" && requiredAndMissing && (
          <Banner kind="warn">
            You must enrol a second factor before continuing to the portal.
          </Banner>
        )}
        {sp.ok && <Banner kind="success">{sp.ok}.</Banner>}
        {sp.error && <Banner kind="error">{sp.error}</Banner>}

        {status.verifiedFactors.length > 0 ? (
          <section className="mt-8">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">
              Verified factors
            </h2>
            <ul className="mt-3 divide-y divide-zinc-200 rounded-lg border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900">
              {status.verifiedFactors.map((f) => (
                <li key={f.id} className="flex items-center justify-between px-4 py-3 text-sm">
                  <div>
                    <p className="font-medium text-zinc-900 dark:text-zinc-50">
                      {f.friendlyName ?? "Authenticator"}
                    </p>
                    <p className="text-xs text-zinc-500">
                      Enrolled {new Date(f.createdAt).toISOString().slice(0, 10)}
                    </p>
                  </div>
                  <form action={unenrol}>
                    <input type="hidden" name="factorId" value={f.id} />
                    <button
                      type="submit"
                      className="rounded-md border border-red-300 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950"
                    >
                      Remove
                    </button>
                  </form>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-zinc-500">
              Removing your last verified factor will drop your session back to AAL1. You will
              be required to enrol again on next sign-in.
            </p>
          </section>
        ) : (
          <section className="mt-8">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">
              Enrol a new authenticator
            </h2>
            <EnrolFlow unverifiedFactors={status.unverifiedFactors} />
          </section>
        )}

        {status.verifiedFactors.length > 0 && (
          recoveryAvailable ? (
            <RecoveryCodesSection existingCount={recoveryCount} />
          ) : (
            <section className="mt-8">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">
                Recovery codes
              </h2>
              <p className="mt-2 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
                Recovery codes require the <code className="font-mono">SUPABASE_SERVICE_ROLE_KEY</code> env var.
                Set it in your deployment to enable self-service recovery; otherwise use the admin-reset path in <code className="font-mono">OPERATIONS.md</code> §1.3.
              </p>
            </section>
          )
        )}

        {status.unverifiedFactors.length > 0 && status.verifiedFactors.length > 0 && (
          <section className="mt-8">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">
              Unverified enrolments
            </h2>
            <p className="mt-2 text-xs text-zinc-500">
              These factors were started but never verified. Remove them if you no longer have access to that device.
            </p>
            <ul className="mt-3 divide-y divide-zinc-200 rounded-lg border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900">
              {status.unverifiedFactors.map((f) => (
                <li key={f.id} className="flex items-center justify-between px-4 py-3 text-sm">
                  <span className="text-zinc-700 dark:text-zinc-300">
                    {f.friendlyName ?? "Authenticator"} —{" "}
                    <span className="text-xs text-zinc-500">
                      started {new Date(f.createdAt).toISOString().slice(0, 10)}
                    </span>
                  </span>
                  <form action={unenrol}>
                    <input type="hidden" name="factorId" value={f.id} />
                    <button
                      type="submit"
                      className="rounded-md border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                    >
                      Remove
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </main>
  );
}

function Banner({ kind, children }: { kind: "warn" | "success" | "error"; children: React.ReactNode }) {
  const cls =
    kind === "warn"
      ? "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
      : kind === "success"
        ? "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
        : "border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-300";
  return (
    <div className={`mt-6 rounded-md border px-3 py-2 text-sm ${cls}`}>{children}</div>
  );
}
