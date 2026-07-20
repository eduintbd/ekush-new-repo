// /login — staff portal sign-in. Server-rendered form posting to a server
// action; no client JS required for the happy path.

import Link from "next/link";
import { signInStaff } from "./actions";

type Search = { next?: string; error?: string };

export const metadata = { title: "Staff sign-in — Ekush ERP" };

export default async function StaffLoginPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const sp = await searchParams;
  const authConfigured = !!(
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-16 dark:bg-zinc-950">
      <div className="mx-auto max-w-md">
        <Link
          href="/"
          className="text-xs uppercase tracking-widest text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
        >
          ← Ekush ERP
        </Link>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Staff sign-in
        </h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          For AMC accountants, admins, and auditors. Selling agents use the{" "}
          <Link href="/agent/login" className="underline">
            agent portal
          </Link>
          .
        </p>

        {!authConfigured && <AuthNotConfigured />}

        <form action={signInStaff} className="mt-8 space-y-4">
          <input type="hidden" name="next" value={sp.next ?? "/dashboard"} />
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
            className="mt-2 w-full rounded-md bg-zinc-900 py-2.5 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            Sign in
          </button>
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
        className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-zinc-900 focus:outline-none disabled:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:focus:border-zinc-100 dark:disabled:bg-zinc-800"
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
