// /agent/investors/[code] — read-only full profile of an investor the agent
// sourced. Mirrors the portal admin investor detail, but every field is
// display-only (no edit). The agent can raise a service request instead.

import Link from "next/link";
import { notFound } from "next/navigation";
import { getAgentScope } from "@/lib/agent-scope";
import {
  getInvestorProfileByCode,
  getBankAccounts,
  getNominees,
  getDocuments,
  getRegistrationSnapshot,
} from "@/lib/portal-investor";
import { signedKycUrl } from "@/lib/kyc-files";
import { fetchInvestorsForAgent } from "@/lib/ekush-web/client";
import { formatBdt } from "@/lib/format";
import RaiseTicketForm from "./RaiseTicketForm";

export const dynamic = "force-dynamic";

const INVESTOR_TYPE_LABELS: Record<string, string> = {
  INDIVIDUAL: "Individual",
  COMPANY_ORGANIZATION: "Company / Organization",
  MUTUAL_FUND: "Mutual Fund",
  PROVIDENT_FUND: "Provident Fund",
  GRATUITY_FUND: "Gratuity Fund",
};

const DOC_LABELS: Record<string, string> = {
  PHOTO: "Photograph",
  SIGNATURE: "Signature",
  NID_FRONT: "NID (front)",
  NID_BACK: "NID (back)",
  TIN_CERT: "e-TIN certificate",
  CHEQUE_LEAF_PHOTO: "Cheque leaf",
  BO_ACKNOWLEDGEMENT: "BO acknowledgement",
  NOMINEE_PHOTO: "Nominee photo",
  NOMINEE_NID_FRONT: "Nominee NID (front)",
  NOMINEE_NID_BACK: "Nominee NID (back)",
  JOINT_PHOTO: "Joint applicant photo",
  JOINT_SIGNATURE: "Joint applicant signature",
  JOINT_NID_FRONT: "Joint NID (front)",
  JOINT_NID_BACK: "Joint NID (back)",
};

function fmtDate(d: Date | null): string {
  return d ? new Date(d).toISOString().slice(0, 10) : "—";
}

export default async function AgentInvestorProfilePage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const scope = await getAgentScope();
  const { code: rawCode } = await params;
  const code = decodeURIComponent(rawCode);

  if (!scope.codeSet.has(code)) notFound();
  const investor = await getInvestorProfileByCode(code);
  if (!investor) notFound();

  const [banks, nominees, docs, snapshot, sourced] = await Promise.all([
    getBankAccounts(investor.id),
    getNominees(investor.id),
    getDocuments(investor.id),
    getRegistrationSnapshot(investor.id),
    fetchInvestorsForAgent(scope.agentCode).catch(() => []),
  ]);

  const funds = sourced.filter((s) => s.investor_code === code);
  const bankUrls = await Promise.all(banks.map((b) => signedKycUrl(b.chequeLeafUrl)));
  const docUrls = await Promise.all(docs.map((d) => signedKycUrl(d.filePath)));
  const permanentAddress =
    (snapshot?.permanentAddress as string | undefined) ??
    ((snapshot?.applicant as Record<string, unknown> | undefined)?.permanentAddress as string | undefined) ??
    null;

  return (
    <main className="min-h-screen bg-emerald-50/30 px-6 py-10 dark:bg-emerald-950/30">
      <div className="mx-auto max-w-4xl space-y-6">
        <div className="text-xs uppercase tracking-widest text-zinc-500">
          <Link href="/agent" className="hover:text-zinc-700 dark:hover:text-zinc-300">← Dashboard</Link>
          <span className="mx-1.5 text-zinc-400">/</span>
          <Link href="/agent/investors" className="hover:text-zinc-700 dark:hover:text-zinc-300">Investors</Link>
        </div>

        <header>
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
            {investor.name}
            {investor.jointApplicantName ? ` & ${investor.jointApplicantName}` : ""}
            <code className="ml-2 text-base font-mono text-zinc-500">{investor.investorCode}</code>
          </h1>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            {INVESTOR_TYPE_LABELS[investor.investorType] ?? investor.investorType} · status{" "}
            <strong>{investor.status}</strong>
          </p>
          <p className="mt-2 rounded-md bg-amber-50 px-3 py-1.5 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200">
            Read-only. You created this registration; once an investor code was assigned it
            can no longer be edited. Use “Raise a request” below for changes.
          </p>
        </header>

        <Section title="Identity">
          <Field label="Name" value={investor.name} />
          <Field label="Investor type" value={INVESTOR_TYPE_LABELS[investor.investorType] ?? investor.investorType} />
          <Field label="Date of birth" value={fmtDate(investor.dateOfBirth)} />
          <Field label="NID number" value={investor.nidNumber} />
          <Field label="e-TIN" value={investor.tinNumber} />
          <Field label="Father's name" value={investor.fatherName} />
          <Field label="Mother's name" value={investor.motherName} />
          <Field label="Spouse's name" value={investor.spouseName} />
          <Field label="BO ID" value={investor.boId} />
          <Field label="DP ID" value={investor.dpId} />
          <Field label="Brokerage house" value={investor.brokerageHouse} />
          <Field label="Dividend option" value={investor.dividendOption} />
        </Section>

        <Section title="Contact">
          <Field label="Email" value={investor.email} />
          <Field label="Phone" value={investor.phone} />
          <Field label="Present address" value={investor.address} full />
          <Field label="Permanent address" value={permanentAddress} full />
        </Section>

        <Section title={`Funds (${funds.length})`}>
          {funds.length === 0 ? (
            <p className="col-span-2 text-sm text-zinc-500">No fund holdings on record.</p>
          ) : (
            <div className="col-span-2 overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="text-left text-[11px] uppercase tracking-wider text-zinc-500">
                  <tr>
                    <th className="py-1 pr-4">Fund</th>
                    <th className="py-1 pr-4">Sourced</th>
                    <th className="py-1 pr-4 text-right">Initial units</th>
                    <th className="py-1 pr-4 text-right">Outstanding</th>
                    <th className="py-1 pr-4 text-right">Initial gross</th>
                  </tr>
                </thead>
                <tbody>
                  {funds.map((f) => (
                    <tr key={`${f.fund_code}-${f.sourced_on}`} className="border-t border-zinc-100 dark:border-zinc-800">
                      <td className="py-1.5 pr-4 font-mono">{f.fund_code}</td>
                      <td className="py-1.5 pr-4">{f.sourced_on}</td>
                      <td className="py-1.5 pr-4 text-right tabular-nums">{formatBdt(f.initial_units)}</td>
                      <td className="py-1.5 pr-4 text-right tabular-nums">{formatBdt(f.units_outstanding)}</td>
                      <td className="py-1.5 pr-4 text-right tabular-nums">
                        {formatBdt(f.initial_units * f.unit_price_at_sourcing)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        <Section title={`Bank accounts (${banks.length})`}>
          {banks.length === 0 ? (
            <p className="col-span-2 text-sm text-zinc-500">No bank accounts on record.</p>
          ) : (
            <div className="col-span-2 space-y-3">
              {banks.map((b, i) => (
                <div key={b.id} className="rounded-md border border-zinc-200 p-3 text-sm dark:border-zinc-800">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{b.bankName}</span>
                    <span className="text-[10px] uppercase tracking-wider text-zinc-500">
                      {b.isPrimary ? "Primary · " : ""}{b.status}
                    </span>
                  </div>
                  <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-zinc-600 dark:text-zinc-400">
                    <span>A/C: {b.accountNumber}</span>
                    <span>Branch: {b.branchName ?? "—"}</span>
                    <span>Routing: {b.routingNumber ?? "—"}</span>
                    {bankUrls[i] && (
                      <a href={bankUrls[i]!} target="_blank" rel="noreferrer" className="text-emerald-700 underline dark:text-emerald-400">
                        View cheque leaf
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section title={`Nominees (${nominees.length})`}>
          {nominees.length === 0 ? (
            <p className="col-span-2 text-sm text-zinc-500">No nominees on record.</p>
          ) : (
            <div className="col-span-2 space-y-2">
              {nominees.map((n) => (
                <div key={n.id} className="text-sm">
                  <span className="font-medium">{n.name}</span>
                  <span className="text-zinc-500"> · {n.relationship ?? "—"} · {n.share}% · NID {n.nidNumber ?? "—"}</span>
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section title={`Documents (${docs.length})`}>
          {docs.length === 0 ? (
            <p className="col-span-2 text-sm text-zinc-500">No documents on record.</p>
          ) : (
            <div className="col-span-2 flex flex-wrap gap-2">
              {docs.map((d, i) =>
                docUrls[i] ? (
                  <a
                    key={d.id}
                    href={docUrls[i]!}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs text-emerald-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-emerald-400 dark:hover:bg-zinc-800"
                  >
                    {DOC_LABELS[d.type] ?? d.type}
                  </a>
                ) : (
                  <span key={d.id} className="rounded-md border border-zinc-200 px-3 py-1.5 text-xs text-zinc-400 dark:border-zinc-800">
                    {DOC_LABELS[d.type] ?? d.type} (unavailable)
                  </span>
                ),
              )}
            </div>
          )}
        </Section>

        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-500">Raise a request</h2>
          <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <RaiseTicketForm code={investor.investorCode} />
          </div>
        </section>
      </div>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-500">{title}</h2>
      <div className="grid grid-cols-1 gap-x-6 gap-y-3 rounded-lg border border-zinc-200 bg-white p-4 sm:grid-cols-2 dark:border-zinc-800 dark:bg-zinc-900">
        {children}
      </div>
    </section>
  );
}

function Field({ label, value, full }: { label: string; value: string | null; full?: boolean }) {
  return (
    <div className={full ? "sm:col-span-2" : ""}>
      <div className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">{label}</div>
      <div className="mt-0.5 text-sm text-zinc-900 dark:text-zinc-100">{value?.trim() ? value : "—"}</div>
    </div>
  );
}
