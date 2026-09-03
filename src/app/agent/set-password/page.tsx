import Link from "next/link";
import { peekTicket } from "@/lib/agent-invite";
import { startPasswordSetup, saveAgentPassword } from "./actions";
import LegacyHashFlow from "./legacy-hash-flow";

// Landing page for the set-password email.
//
// THE IMPORTANT PROPERTY OF THIS PAGE: rendering it must change nothing.
// Corporate mail gateways (Defender SafeLinks, Proofpoint URL Defense) and
// chat link-preview crawlers GET every URL in a message. When the email
// carried Supabase's own one-time verify URL, that GET spent the token — 17
// seconds after the invite left, in agent F00000's case — and the agent's own
// click then hit `error_code=otp_expired`. So the ticket in `?t=` is redeemed
// only by the POST behind the button below, which no prefetcher issues.
//
// Three shapes arrive here:
//   ?t=<ticket>   the new emailed link — confirm screen, then POST to redeem
//   ?stage=set    post-redemption, session is in cookies — the password form
//   #access_token pre-ticket links still in flight, and stray Supabase
//                 landings forwarded by RecoveryHashRedirect — LegacyHashFlow

export const metadata = { title: "Set your password — Ekush" };

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-50 px-6 dark:bg-zinc-950">
      <div className="w-full max-w-sm">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">Set your password</h1>
        {children}
      </div>
    </main>
  );
}

function ErrorNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
      {children}
    </p>
  );
}

function DeadEnd({ message }: { message: string }) {
  return (
    <div className="mt-4 space-y-3">
      <ErrorNote>{message}</ErrorNote>
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
  );
}

export default async function AgentSetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ t?: string; stage?: string; error?: string }>;
}) {
  const sp = await searchParams;

  // ── The password form, after the ticket has been redeemed ──────────
  if (sp.stage === "set") {
    return (
      <Shell>
        <form action={saveAgentPassword} className="mt-6 space-y-3">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            At least 10 characters, with an uppercase and lowercase letter, a digit, and a symbol.
          </p>
          <input
            type="password"
            name="password"
            required
            autoComplete="new-password"
            placeholder="New password"
            className="block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
          <input
            type="password"
            name="confirm"
            required
            autoComplete="new-password"
            placeholder="Confirm password"
            className="block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
          {sp.error && <p className="text-sm text-red-600 dark:text-red-400">{sp.error}</p>}
          <button
            type="submit"
            className="w-full rounded-md bg-zinc-900 py-2.5 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900"
          >
            Set password
          </button>
        </form>
      </Shell>
    );
  }

  // ── The emailed ticket ─────────────────────────────────────────────
  if (sp.t) {
    const state = await peekTicket(sp.t);

    if (state !== "valid") {
      return (
        <Shell>
          <DeadEnd
            message={
              state === "used"
                ? "This link has already been used. If that wasn't you, request a fresh one below."
                : state === "expired"
                  ? "This link has expired. Request a fresh one below."
                  : "This link is not valid. Request a fresh one below."
            }
          />
        </Shell>
      );
    }

    return (
      <Shell>
        <div className="mt-4 space-y-4">
          {sp.error && <ErrorNote>{sp.error}</ErrorNote>}
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Click below to choose your password. This works once, so finish on this screen.
          </p>
          <form action={startPasswordSetup}>
            <input type="hidden" name="token" value={sp.t} />
            <button
              type="submit"
              className="w-full rounded-md bg-zinc-900 py-2.5 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900"
            >
              Continue
            </button>
          </form>
          <Link href="/agent/login" className="block text-sm text-zinc-700 underline dark:text-zinc-300">
            Back to sign in
          </Link>
        </div>
      </Shell>
    );
  }

  // ── A bare ?error= from a failed redemption ────────────────────────
  if (sp.error) {
    return (
      <Shell>
        <DeadEnd message={sp.error} />
      </Shell>
    );
  }

  // ── Anything else: a pre-ticket link, whose session is in the hash ──
  return (
    <Shell>
      <LegacyHashFlow />
    </Shell>
  );
}
