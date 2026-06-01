// /admin/agents/new — invite a selling agent (creates a pending row).
// Approving the agent later seeds default AgentTerm rows per spec §5.5.

import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { createAgent } from "@/app/admin/agents/actions";

type Search = { error?: string };

export const metadata = { title: "Invite agent — Admin" };

export default async function NewAgentPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  await requireRole(["admin", "checker"]);
  const sp = await searchParams;

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10 dark:bg-zinc-950">
      <div className="mx-auto max-w-md">
        <div className="text-xs uppercase tracking-widest text-zinc-500">
          <Link href="/dashboard" className="hover:text-zinc-700 dark:hover:text-zinc-300">← Dashboard</Link>
          <span className="mx-1.5 text-zinc-400">/</span>
          <Link href="/admin/agents" className="hover:text-zinc-700 dark:hover:text-zinc-300">Agents</Link>
        </div>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Invite selling agent
        </h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Creates a pending agent record. Approve it from the detail page to
          seed default terms (Equity 0.20%/0.40%/0.35%; Fixed Income
          0.20%/0.20%/0.15%).
        </p>

        {sp.error && (
          <div className="mt-4 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
            {sp.error}
          </div>
        )}

        <form action={createAgent} className="mt-8 space-y-4">
          <Field name="code" label="Agent code (e.g. SB0001)" required />
          <Field name="fullName" label="Full name" required />
          <Field name="email" type="email" label="Email" required />
          <Field name="phone" label="Phone (optional)" />
          <button
            type="submit"
            className="mt-4 w-full rounded-md bg-zinc-900 py-2.5 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900"
          >
            Create pending agent
          </button>
        </form>
      </div>
    </main>
  );
}

function Field({
  name,
  label,
  type = "text",
  required = false,
}: {
  name: string;
  label: string;
  type?: string;
  required?: boolean;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium uppercase tracking-wider text-zinc-600 dark:text-zinc-400">
        {label}
      </span>
      <input
        name={name}
        type={type}
        required={required}
        className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-zinc-900 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900"
      />
    </label>
  );
}
