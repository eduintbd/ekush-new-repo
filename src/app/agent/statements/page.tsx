// /agent/statements — download investor statements as PDF. Pick one of the
// agent's investors, choose a statement tab, then download per fund (or all
// funds). No on-screen detail per the requirement — just the PDF.

import Link from "next/link";
import { getAgentScope } from "@/lib/agent-scope";
import { fetchInvestorsForAgent } from "@/lib/ekush-web/client";

export const dynamic = "force-dynamic";

const TABS = [
  { key: "portfolio", label: "Portfolio" },
  { key: "transactions", label: "Transactions" },
  { key: "dividends", label: "Dividends" },
  { key: "tax", label: "Tax Certificates" },
] as const;

export default async function AgentStatementsPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string; tab?: string }>;
}) {
  const scope = await getAgentScope();
  const sp = await searchParams;
  const sourced = await fetchInvestorsForAgent(scope.agentCode).catch(() => []);

  // Group the agent's investors by code, collecting the funds each holds.
  const byCode = new Map<string, { name: string; funds: Set<string> }>();
  for (const s of sourced) {
    const e = byCode.get(s.investor_code) ?? { name: s.full_name, funds: new Set<string>() };
    e.funds.add(s.fund_code);
    byCode.set(s.investor_code, e);
  }
  const investors = Array.from(byCode.entries())
    .map(([code, v]) => ({ code, name: v.name, funds: Array.from(v.funds).sort() }))
    .sort((a, b) => a.code.localeCompare(b.code));

  const selectedCode = sp.code && byCode.has(sp.code) ? sp.code : undefined;
  const selected = selectedCode ? investors.find((i) => i.code === selectedCode) : undefined;
  const tab = TABS.find((t) => t.key === sp.tab)?.key ?? "portfolio";

  return (
    <main className="min-h-screen bg-emerald-50/30 px-6 py-10 dark:bg-emerald-950/30">
      <div className="mx-auto max-w-5xl space-y-6">
        <div className="text-xs uppercase tracking-widest text-zinc-500">
          <Link href="/agent" className="hover:text-zinc-700 dark:hover:text-zinc-300">← Dashboard</Link>
        </div>
        <div>
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">Statements</h1>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            Download portfolio, transaction, dividend and tax-certificate PDFs for the
            investors you sourced.
          </p>
        </div>

        <div className="grid gap-6 sm:grid-cols-[220px_1fr]">
          {/* Investor picker */}
          <aside className="rounded-lg border border-zinc-200 bg-white p-2 dark:border-zinc-800 dark:bg-zinc-900">
            <p className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              Investor ({investors.length})
            </p>
            {investors.length === 0 ? (
              <p className="px-2 py-2 text-xs text-zinc-500">No investors yet.</p>
            ) : (
              <ul className="max-h-[60vh] space-y-0.5 overflow-y-auto">
                {investors.map((inv) => (
                  <li key={inv.code}>
                    <Link
                      href={`/agent/statements?code=${encodeURIComponent(inv.code)}&tab=${tab}`}
                      className={`block rounded px-2 py-1.5 text-sm ${
                        inv.code === selectedCode
                          ? "bg-emerald-100 font-medium text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200"
                          : "text-zinc-700 hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-800"
                      }`}
                    >
                      <span className="font-mono text-xs">{inv.code}</span>
                      <span className="ml-2 text-zinc-500">{inv.name}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </aside>

          {/* Statement tabs + downloads */}
          <section className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            {!selected ? (
              <p className="text-sm text-zinc-500">Select an investor to see their statements.</p>
            ) : (
              <>
                <div className="mb-4 flex flex-wrap gap-1 border-b border-zinc-200 dark:border-zinc-800">
                  {TABS.map((t) => (
                    <Link
                      key={t.key}
                      href={`/agent/statements?code=${encodeURIComponent(selectedCode!)}&tab=${t.key}`}
                      className={`px-3 py-2 text-sm ${
                        t.key === tab
                          ? "border-b-2 border-emerald-600 font-medium text-emerald-700 dark:text-emerald-400"
                          : "text-zinc-600 hover:text-zinc-900 dark:text-zinc-400"
                      }`}
                    >
                      {t.label}
                    </Link>
                  ))}
                </div>

                <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-400">
                  {selectedCode} · {selected.name} — download the{" "}
                  {TABS.find((t) => t.key === tab)!.label.toLowerCase()} PDF:
                </p>

                <div className="flex flex-wrap gap-2">
                  <DownloadBtn code={selectedCode!} type={tab} label="All funds" />
                  {selected.funds.map((f) => (
                    <DownloadBtn key={f} code={selectedCode!} type={tab} fundCode={f} label={f} />
                  ))}
                </div>
              </>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}

function DownloadBtn({
  code,
  type,
  fundCode,
  label,
}: {
  code: string;
  type: string;
  fundCode?: string;
  label: string;
}) {
  const href = `/api/agent/statements?code=${encodeURIComponent(code)}&type=${type}${
    fundCode ? `&fundCode=${encodeURIComponent(fundCode)}` : ""
  }`;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
    >
      ↓ {label} (PDF)
    </a>
  );
}
