// /journals/voucher/[batchId] — printable voucher view of one compound
// journal entry (= one batch). Designed to print cleanly on A4 (one
// voucher per page) so accountants can keep paper records with the
// AMC's letterhead. Reachable from /day-book, /journals (voucher#
// links), and the audit log.

import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaff } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { formatBdt } from "@/lib/format";
import { PrintButton } from "@/components/print-button";

export const metadata = { title: "Voucher — Staff portal" };

export default async function VoucherPage({
  params,
}: {
  params: Promise<{ batchId: string }>;
}) {
  await requireStaff();
  const { batchId } = await params;

  const lines = await prisma.journal.findMany({
    where: { batchId },
    orderBy: [{ debit: "desc" }, { credit: "asc" }, { createdAt: "asc" }],
    include: { fiscalYear: { select: { label: true } } },
  });
  if (lines.length === 0) notFound();

  const head = lines[0];
  const totalDebit = lines.reduce((s, l) => s + Number(l.debit), 0);
  const totalCredit = lines.reduce((s, l) => s + Number(l.credit), 0);

  // Lookup creator profile for the audit footer
  const creator = head.createdBy
    ? await prisma.profile.findUnique({
        where: { id: head.createdBy },
        select: { email: true, fullName: true },
      })
    : null;

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10 dark:bg-zinc-950">
      <div className="mx-auto max-w-3xl">
        <div className="no-print flex items-center justify-between">
          <div className="text-xs uppercase tracking-widest text-zinc-500">
            <Link href="/dashboard" className="hover:text-zinc-700 dark:hover:text-zinc-300">← Dashboard</Link>
            <span className="mx-1.5 text-zinc-400">/</span>
            <Link href="/journals" className="hover:text-zinc-700 dark:hover:text-zinc-300">Journals</Link>
            <span className="mx-1.5 text-zinc-400">/</span>
            <span className="text-zinc-700 dark:text-zinc-300">{head.voucherNo ?? "voucher"}</span>
          </div>
          <PrintButton />
        </div>

        {/* Voucher card — this is what prints */}
        <article className="mt-4 rounded-lg border border-zinc-300 bg-white p-8 print:border-0 print:p-0 print:shadow-none dark:border-zinc-700 dark:bg-zinc-900">
          <header className="border-b border-zinc-300 pb-4 dark:border-zinc-700">
            <p className="text-center text-xs uppercase tracking-[0.3em] text-zinc-500">
              Ekush Wealth Management Limited
            </p>
            <h1 className="mt-1 text-center text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
              Journal Voucher
            </h1>
          </header>

          <dl className="mt-5 grid grid-cols-2 gap-3 text-sm">
            <Row label="Voucher #" value={head.voucherNo ?? "—"} mono />
            <Row label="Date" value={head.entryDate.toISOString().slice(0, 10)} mono />
            <Row label="Type" value={head.txnType ?? "JV"} />
            <Row label="Fiscal year" value={head.fiscalYear.label} />
            {head.instrumentCode && <Row label="Instrument" value={head.instrumentCode} mono />}
            {head.challanNo && <Row label="Challan #" value={head.challanNo} mono />}
          </dl>

          {head.description && (
            <p className="mt-5 rounded border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-700 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300">
              <strong className="font-semibold">Narration:</strong> {head.description}
            </p>
          )}

          <table className="mt-6 w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-zinc-300 dark:border-zinc-700">
                <th className="px-2 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-600 dark:text-zinc-400">
                  Account
                </th>
                <th className="px-2 py-2 text-right text-[11px] font-semibold uppercase tracking-wider text-zinc-600 dark:text-zinc-400">
                  Debit (BDT)
                </th>
                <th className="px-2 py-2 text-right text-[11px] font-semibold uppercase tracking-wider text-zinc-600 dark:text-zinc-400">
                  Credit (BDT)
                </th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={l.id} className={i % 2 === 0 ? "" : "bg-zinc-50 print:bg-transparent dark:bg-zinc-950"}>
                  <td className="px-2 py-2">
                    {l.accountName}
                    {l.instrumentCode && (
                      <Link
                        href={`/ledger/${encodeURIComponent(l.accountName)}?fy=${l.fiscalYearId}&instrument=${encodeURIComponent(l.instrumentCode)}`}
                        className="ml-2 rounded bg-sky-100 px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wider text-sky-800 hover:bg-sky-200 print:bg-transparent print:p-0 dark:bg-sky-950 dark:text-sky-200 dark:hover:bg-sky-900"
                      >
                        {l.instrumentCode}
                      </Link>
                    )}
                  </td>
                  <td className="px-2 py-2 text-right font-mono tabular-nums">
                    {Number(l.debit) > 0 ? formatBdt(Number(l.debit)) : ""}
                  </td>
                  <td className="px-2 py-2 text-right font-mono tabular-nums">
                    {Number(l.credit) > 0 ? formatBdt(Number(l.credit)) : ""}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-zinc-700 dark:border-zinc-300">
                <td className="px-2 py-2 text-right text-xs font-semibold uppercase tracking-wider">
                  Totals
                </td>
                <td className="px-2 py-2 text-right font-mono font-semibold tabular-nums">
                  {formatBdt(totalDebit)}
                </td>
                <td className="px-2 py-2 text-right font-mono font-semibold tabular-nums">
                  {formatBdt(totalCredit)}
                </td>
              </tr>
            </tfoot>
          </table>

          {Math.abs(totalDebit - totalCredit) > 0.005 && (
            <p className="mt-3 text-center text-xs text-red-700 dark:text-red-300">
              ✗ Voucher is unbalanced by {formatBdt(totalDebit - totalCredit)} — investigate.
            </p>
          )}

          <footer className="mt-10 grid grid-cols-3 gap-6 text-xs text-zinc-600 dark:text-zinc-400">
            <SignatureBlock label="Prepared by" hint={creator?.fullName ?? creator?.email ?? "—"} />
            <SignatureBlock label="Checked by" hint="" />
            <SignatureBlock label="Approved by" hint="" />
          </footer>

          <p className="mt-8 text-center text-[10px] text-zinc-400">
            Generated by Ekush ERP · {new Date().toISOString().slice(0, 19).replace("T", " ")} UTC
            {" · "}batch {batchId.slice(0, 8)}
          </p>
        </article>
      </div>
    </main>
  );
}

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between border-b border-dashed border-zinc-200 py-1 dark:border-zinc-800">
      <dt className="text-zinc-500">{label}</dt>
      <dd className={`text-zinc-900 dark:text-zinc-50 ${mono ? "font-mono text-xs" : ""}`}>{value}</dd>
    </div>
  );
}

function SignatureBlock({ label, hint }: { label: string; hint: string }) {
  return (
    <div>
      <div className="border-t border-zinc-700 pt-1 text-center dark:border-zinc-300">
        <p className="text-[10px] uppercase tracking-wider">{label}</p>
        {hint && <p className="mt-0.5 text-[10px] text-zinc-500">{hint}</p>}
      </div>
    </div>
  );
}
