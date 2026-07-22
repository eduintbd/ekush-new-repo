// /agent/marketing — the marketing library. Every active item the admin
// uploaded, with a download link the agent can save and share with clients.

import Link from "next/link";
import { requireAgent } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { signedKycUrls } from "@/lib/kyc-files";
import { MARKETING_LABELS, type MarketingCategory } from "@/lib/marketing-contents";

export const dynamic = "force-dynamic";

export default async function AgentMarketingPage() {
  await requireAgent();

  const items = await prisma.agentMarketingContent.findMany({
    where: { isActive: true },
    orderBy: { createdAt: "desc" },
  });
  const urls = await signedKycUrls(items.map((i) => i.filePath));

  return (
    <main className="min-h-screen bg-emerald-50/30 px-6 py-10 dark:bg-emerald-950/30">
      <div className="mx-auto max-w-4xl space-y-6">
        <div className="text-xs uppercase tracking-widest text-zinc-500">
          <Link href="/agent" className="hover:text-zinc-700 dark:hover:text-zinc-300">← Dashboard</Link>
        </div>
        <div>
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">Marketing contents</h1>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            Flyers, brochures and forms to download and share with your clients.
          </p>
        </div>

        <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          {items.length === 0 ? (
            <p className="text-sm text-zinc-500">No marketing contents available yet. Check back soon.</p>
          ) : (
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {items.map((item, i) => (
                <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">{item.title}</p>
                    <p className="text-xs text-zinc-500">
                      {MARKETING_LABELS[item.category as MarketingCategory] ?? item.category}
                      {item.mimeType === "application/pdf" ? " · PDF" : " · Image"}
                      {" · "}{item.createdAt.toISOString().slice(0, 10)}
                    </p>
                  </div>
                  {urls[i] ? (
                    <a
                      href={urls[i]!}
                      target="_blank"
                      rel="noopener noreferrer"
                      download={item.fileName}
                      className="rounded-md bg-[#F27023] px-4 py-2 text-sm font-medium text-white hover:bg-[#d9631d]"
                    >
                      ↓ Download
                    </a>
                  ) : (
                    <span className="text-xs text-amber-700 dark:text-amber-400">link unavailable</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <p className="text-[11px] text-zinc-500">
          Download links are private and expire after 5 minutes — download the file, then share the
          saved file with your client. Reload this page to get a fresh link.
        </p>
      </div>
    </main>
  );
}
