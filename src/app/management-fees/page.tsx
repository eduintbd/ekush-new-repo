// /management-fees — cross-system management-fee verification. Pulls the
// AMC's earned management fee per (fund, period) by parsing each fund's
// FIN_STATS xlsx (uploaded via ekush-portal admin panel). Accountant
// verifies the computed amount; can override via `manualAmount` and mark
// the row as reviewed/verified.

import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { formatBdt } from "@/lib/format";
import { runImportLatest, setManualAmount, setStatus } from "./actions";

type Search = { ok?: string; error?: string };

export const metadata = { title: "Management fees — Staff portal" };

export default async function MgmtFeesPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  await requireRole(["admin", "accountant", "auditor"]);
  const sp = await searchParams;

  const imports = await prisma.managementFeeImport
    .findMany({ orderBy: [{ periodEnd: "desc" }, { fundCode: "asc" }] })
    .catch(() => []);

  // Latest FIN_STATS uploads from ekush-portal (read-only, public schema)
  type UploadRow = { id: string; fundId: string; fundCode: string; fundName: string; reportDate: Date; fileName: string; filePath: string; status: string };
  let latestUploads: UploadRow[] = [];
  try {
    latestUploads = await prisma.$queryRawUnsafe<UploadRow[]>(
      `SELECT DISTINCT ON (u."fundId")
              u.id, u."fundId", f.code AS "fundCode", f.name AS "fundName",
              u."reportDate", u."fileName", u."filePath", u.status
       FROM public.daily_fund_uploads u
       JOIN public.funds f ON f.id = u."fundId"
       WHERE u."uploadType" = 'FIN_STATS'
       ORDER BY u."fundId", u."reportDate" DESC`,
    );
  } catch (e) {
    // public schema may not be reachable from this Supabase project
    console.warn("Failed to read public.daily_fund_uploads", e);
  }

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10 dark:bg-zinc-950">
      <div className="mx-auto max-w-6xl">
        <Link href="/dashboard" className="text-xs uppercase tracking-widest text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
          ← Dashboard
        </Link>
        <div className="mt-3 flex items-end justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-widest text-zinc-500">Staff portal</p>
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
              Fund management fees
            </h1>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              Pulls each fund's accumulated management fee from its FIN_STATS xlsx (uploaded via ekush-portal).
              Edit any computed amount manually and mark the row as verified once you've checked.
            </p>
          </div>
          <form action={runImportLatest}>
            <button
              type="submit"
              className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
            >
              ↻ Re-import from latest FIN_STATS
            </button>
          </form>
        </div>

        {sp.ok && (
          <div className="mt-4 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
            {sp.ok}
          </div>
        )}
        {sp.error && (
          <div className="mt-4 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
            {sp.error}
          </div>
        )}

        {/* Source uploads info */}
        <section className="mt-6">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
            Latest FIN_STATS uploads (source data)
          </h2>
          {latestUploads.length === 0 ? (
            <p className="mt-2 text-xs text-zinc-500">
              No FIN_STATS uploads visible from <code>public.daily_fund_uploads</code>.
            </p>
          ) : (
            <ul className="mt-2 grid gap-2 sm:grid-cols-3">
              {latestUploads.map((u) => (
                <li key={u.id} className="rounded-md border border-zinc-200 bg-white p-3 text-xs dark:border-zinc-800 dark:bg-zinc-900">
                  <p className="font-semibold text-zinc-900 dark:text-zinc-50">
                    {u.fundCode} — {u.fundName}
                  </p>
                  <p className="mt-1 text-zinc-600 dark:text-zinc-400">
                    Report date: {u.reportDate.toISOString().slice(0, 10)}
                  </p>
                  <a
                    href={u.filePath}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1 block truncate text-[10px] text-blue-600 underline dark:text-blue-400"
                  >
                    {u.fileName} ↗
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="mt-8">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
            Imports ({imports.length})
          </h2>
          {imports.length === 0 ? (
            <p className="mt-2 text-sm text-zinc-500">
              No imports yet. Click <em>Re-import from latest FIN_STATS</em> above to extract management fees.
            </p>
          ) : (
            <div className="mt-2 overflow-x-auto rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
              <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
                <thead className="bg-zinc-50 dark:bg-zinc-950">
                  <tr>
                    <Th>Fund</Th>
                    <Th>Period</Th>
                    <Th align="right">Computed (from xlsx)</Th>
                    <Th align="right">Manual override</Th>
                    <Th align="right">Effective</Th>
                    <Th>Status</Th>
                    <Th>Source</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {imports.map((m) => {
                    const computed = Number(m.computedAmount);
                    const manual = m.manualAmount == null ? null : Number(m.manualAmount);
                    const effective = manual ?? computed;
                    return (
                      <tr key={m.id}>
                        <Td className="font-medium">
                          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                            {m.fundCode}
                          </span>
                        </Td>
                        <Td className="text-xs text-zinc-600 dark:text-zinc-400">
                          {m.periodStart.toISOString().slice(0, 10)} → {m.periodEnd.toISOString().slice(0, 10)}
                        </Td>
                        <Td align="right" className="font-mono">{formatBdt(computed)}</Td>
                        <Td align="right">
                          <form action={setManualAmount} className="flex items-center justify-end gap-1">
                            <input type="hidden" name="id" value={m.id} />
                            <input
                              type="number"
                              step="0.01"
                              name="manualAmount"
                              defaultValue={manual ?? ""}
                              placeholder="—"
                              className="w-28 rounded border border-zinc-300 bg-white px-2 py-1 text-right font-mono text-xs tabular-nums dark:border-zinc-700 dark:bg-zinc-950"
                            />
                            <button type="submit" className="rounded border border-zinc-300 px-2 py-0.5 text-[10px] font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">
                              Save
                            </button>
                          </form>
                        </Td>
                        <Td align="right" className="font-mono font-semibold">{formatBdt(effective)}</Td>
                        <Td>
                          <form action={setStatus} className="flex items-center gap-1">
                            <input type="hidden" name="id" value={m.id} />
                            <select
                              name="status"
                              defaultValue={m.status}
                              className="rounded border border-zinc-300 bg-white px-1 py-0.5 text-[10px] dark:border-zinc-700 dark:bg-zinc-950"
                            >
                              <option value="imported">imported</option>
                              <option value="reviewed">reviewed</option>
                              <option value="verified">verified</option>
                            </select>
                            <button type="submit" className="rounded border border-zinc-300 px-2 py-0.5 text-[10px] font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">
                              Set
                            </button>
                          </form>
                        </Td>
                        <Td className="text-[10px] text-zinc-500">
                          {m.sourceFileName ?? "—"}
                          {m.notes && (
                            <span className="block text-zinc-400">{m.notes}</span>
                          )}
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <p className="mt-6 text-[11px] text-zinc-500">
          The importer parses the <strong>Journals</strong> sheet of each fund's FIN_STATS xlsx and sums
          all "Management Fee" debit lines from the start of the open fiscal year up to the upload's
          report date. If the fund's xlsx structure changes, edit{" "}
          <code>src/app/management-fees/actions.ts</code> &gt; <code>parseManagementFeeFromXlsx</code>.
        </p>
      </div>
    </main>
  );
}

function Th({ children, align = "left" }: { children?: React.ReactNode; align?: "left" | "right" }) {
  const a = align === "right" ? "text-right" : "text-left";
  return <th className={`${a} px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500`}>{children}</th>;
}

function Td({ children, align = "left", className = "" }: { children?: React.ReactNode; align?: "left" | "right"; className?: string }) {
  const a = align === "right" ? "text-right tabular-nums" : "text-left";
  return <td className={`${a} px-4 py-2 ${className}`}>{children}</td>;
}
