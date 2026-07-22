// /admin/marketing — admin uploads marketing content (jpg/pdf) that every
// selling agent can download from /agent/marketing and share with clients.

import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { signedKycUrls } from "@/lib/kyc-files";
import { MARKETING_LABELS, type MarketingCategory } from "@/lib/marketing-contents";
import MarketingUploadForm from "./MarketingUploadForm";
import { deleteMarketingContent } from "./actions";

export const dynamic = "force-dynamic";

export default async function AdminMarketingPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  await requireRole(["admin", "checker"]);
  const sp = await searchParams;

  const items = await prisma.agentMarketingContent.findMany({
    orderBy: { createdAt: "desc" },
  });
  const urls = await signedKycUrls(items.map((i) => i.filePath));

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10 dark:bg-zinc-950">
      <div className="mx-auto max-w-4xl space-y-6">
        <div className="text-xs uppercase tracking-widest text-zinc-500">
          <Link href="/dashboard" className="hover:text-zinc-700 dark:hover:text-zinc-300">← Dashboard</Link>
        </div>
        <div>
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">Marketing contents</h1>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            Upload flyers, brochures and forms here. Every selling agent can download them from their
            dashboard and share with clients.
          </p>
        </div>

        {sp.ok && (
          <p className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">{sp.ok}</p>
        )}
        {sp.error && (
          <p className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">{sp.error}</p>
        )}

        <section className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-500">Upload new</h2>
          <MarketingUploadForm />
        </section>

        <section className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-500">
            Uploaded ({items.length})
          </h2>
          {items.length === 0 ? (
            <p className="text-sm text-zinc-500">Nothing uploaded yet.</p>
          ) : (
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {items.map((item, i) => (
                <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">{item.title}</p>
                    <p className="text-xs text-zinc-500">
                      {MARKETING_LABELS[item.category as MarketingCategory] ?? item.category} ·{" "}
                      {item.fileName} · {item.createdAt.toISOString().slice(0, 10)}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {urls[i] ? (
                      <a
                        href={urls[i]!}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium dark:border-zinc-700"
                      >
                        View
                      </a>
                    ) : (
                      <span className="text-xs text-amber-700 dark:text-amber-400">link unavailable</span>
                    )}
                    <form action={deleteMarketingContent} data-confirm={`Remove "${item.title}"?`}>
                      <input type="hidden" name="id" value={item.id} />
                      <button className="rounded-md border border-red-300 px-3 py-1.5 text-xs font-medium text-red-700 dark:border-red-900 dark:text-red-300">
                        Remove
                      </button>
                    </form>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
