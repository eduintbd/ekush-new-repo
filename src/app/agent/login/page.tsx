// /agent/login — selling-agent sign-in. Visually distinct from /login so
// agents can't accidentally try the wrong portal.

import Link from "next/link";
import { signInAgent } from "./actions";

type Search = { next?: string; error?: string; ok?: string };

export const metadata = { title: "Agent sign-in — Ekush ERP" };

export default async function AgentLoginPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const sp = await searchParams;
  const authConfigured = !!(
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );

  return (
    <main className="min-h-screen bg-gradient-to-br from-emerald-50 via-zinc-50 to-emerald-50 px-6 py-16 dark:from-emerald-950 dark:via-zinc-950 dark:to-emerald-950">
      <div className="mx-auto max-w-md">
        <Link
          href="/"
          className="text-xs uppercase tracking-widest text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
        >
          ← Ekush ERP
        </Link>
        <div className="mt-3 inline-flex items-center gap-2 rounded-full bg-emerald-100 px-3 py-1 text-xs font-medium text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200">
          Selling agent portal
        </div>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Agent sign-in
        </h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          For approved selling agents. Staff use the{" "}
          <Link href="/login" className="underline">
            staff portal
          </Link>
          .
        </p>

        {!authConfigured && <AuthNotConfigured />}

        {sp.ok && (
          <p className="mt-6 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
            {sp.ok}
          </p>
        )}

        <form action={signInAgent} className="mt-8 space-y-4">
          <input type="hidden" name="next" value={sp.next ?? "/agent"} />
          <Field
            label="Email"
            name="email"
            type="email"
            autoComplete="email"
            required
            disabled={!authConfigured}
          />
          <Field
            label="Password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            disabled={!authConfigured}
          />

          {sp.error && <p className="text-sm text-red-600 dark:text-red-400">{sp.error}</p>}

          <button
            type="submit"
            disabled={!authConfigured}
            className="mt-2 w-full rounded-md bg-emerald-700 py-2.5 text-sm font-medium text-white transition-colors hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-emerald-600 dark:hover:bg-emerald-500"
          >
            Sign in
          </button>

          <p className="text-center text-sm">
            <Link
              href="/agent/forgot-password"
              className="text-emerald-700 underline-offset-2 hover:underline dark:text-emerald-400"
            >
              Forgot password?
            </Link>
          </p>
        </form>
      </div>
    </main>
  );
}

function Field(props: React.InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  const { label, ...rest } = props;
  return (
    <label className="block">
      <span className="text-xs font-medium uppercase tracking-wider text-zinc-600 dark:text-zinc-400">
        {label}
      </span>
      <input
        {...rest}
        className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-emerald-700 focus:outline-none disabled:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:focus:border-emerald-400 dark:disabled:bg-zinc-800"
      />
    </label>
  );
}

function AuthNotConfigured() {
  return (
    <div className="mt-6 rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
      <p className="font-medium">Auth not configured</p>
      <p className="mt-1 text-xs">
        Set <code className="font-mono">NEXT_PUBLIC_SUPABASE_URL</code> and{" "}
        <code className="font-mono">NEXT_PUBLIC_SUPABASE_ANON_KEY</code> in{" "}
        <code className="font-mono">.env.local</code> to enable sign-in.
      </p>
    </div>
  );
}
