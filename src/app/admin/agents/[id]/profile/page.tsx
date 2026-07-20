// /admin/agents/[id]/profile — profile management for a selling agent:
// identity + contact + personal details, payout bank accounts, nominee,
// and the uploaded document set. Commission terms and investor links stay
// on the detail page (/admin/agents/[id]); this page is purely the
// agent's own record.

import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { UserRole } from "@/generated/prisma";
import { signedKycUrls } from "@/lib/kyc-files";
import { AGENT_DOC_GROUPS, AGENT_DOC_LABELS, type AgentDocType } from "@/lib/agent-documents";
import DocumentUploadForm from "./DocumentUploadForm";
import {
  addAgentBankAccount,
  addAgentNominee,
  deleteAgentBankAccount,
  deleteAgentDocument,
  deleteAgentNominee,
  setPrimaryAgentBank,
  updateAgentProfile,
} from "./actions";

type Search = { ok?: string; error?: string };

function ymd(d: Date | null | undefined): string {
  return d ? d.toISOString().slice(0, 10) : "";
}

export default async function AgentProfilePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Search>;
}) {
  const me = await requireRole(["admin", "checker"]);
  const isAdmin = me.role === UserRole.admin;
  const { id } = await params;
  const sp = await searchParams;

  const agent = await prisma.sellingAgent
    .findUnique({
      where: { id },
      include: {
        bankAccounts: { orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }] },
        nominees: { orderBy: { createdAt: "asc" } },
        documents: { orderBy: { createdAt: "desc" } },
        // Their actual sign-in identity, which can drift from
        // SellingAgent.email after an email edit.
        profile: { select: { email: true } },
      },
    })
    .catch(() => null);

  if (!agent) notFound();

  // Signed URLs must be resolved before JSX — a Server Component can't
  // await inside the tree.
  const signed = await signedKycUrls(agent.documents.map((d) => d.filePath));
  const urlById = new Map(agent.documents.map((d, i) => [d.id, signed[i]]));

  // Latest upload per doc type drives the "current" column; older files
  // for the same type stay listed underneath as superseded versions.
  const latestByType = new Map<string, (typeof agent.documents)[number]>();
  for (const doc of agent.documents) {
    if (!latestByType.has(doc.type)) latestByType.set(doc.type, doc); // documents are desc by createdAt
  }

  const nomineeShareUsed = agent.nominees.reduce((sum, n) => sum + Number(n.share), 0);

  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-10">
      <Link
        href={`/admin/agents/${agent.id}`}
        className="text-xs uppercase tracking-widest text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
      >
        ← {agent.code} · {agent.fullName}
      </Link>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
        Profile management
      </h1>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
        The agent sees this record read-only at <code className="font-mono">/agent/profile</code>.
        Documents can only be uploaded here.
      </p>

      {sp.ok && (
        <p className="mt-4 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">
          {sp.ok}
        </p>
      )}
      {sp.error && (
        <p className="mt-4 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          {sp.error}
        </p>
      )}

      {/* ── Identity + personal + contact ─────────────────────────── */}
      <Section title="Agent details">
        <form action={updateAgentProfile} className="mt-1">
          <input type="hidden" name="agentId" value={agent.id} />

          <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-1 rounded-md bg-zinc-100 px-3 py-2 text-sm dark:bg-zinc-900">
            <span>
              <span className="text-[10px] uppercase tracking-wider text-zinc-500">Agent code</span>{" "}
              <span className="font-mono font-semibold">{agent.code}</span>
            </span>
            <span>
              <span className="text-[10px] uppercase tracking-wider text-zinc-500">Status</span>{" "}
              <span className="font-medium">{agent.status}</span>
            </span>
            <span className="text-xs text-zinc-500">
              The agent code is the commission-ledger key and cannot be changed here.
            </span>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <Field name="title" label="Title" defaultValue={agent.title ?? ""} placeholder="Mr." />
            <div className="sm:col-span-2">
              <Field name="fullName" label="Full name" defaultValue={agent.fullName} required />
            </div>
            <Field name="email" label="Email" type="email" defaultValue={agent.email} required />
            <Field name="phone" label="Phone" defaultValue={agent.phone ?? ""} placeholder="01XXXXXXXXX" />
            <Field name="dateOfBirth" label="Date of birth" type="date" defaultValue={ymd(agent.dateOfBirth)} />
            <Field name="fatherName" label="Father's name" defaultValue={agent.fatherName ?? ""} />
            <Field name="nidNumber" label="NID number" defaultValue={agent.nidNumber ?? ""} />
            <Field name="tinNumber" label="TIN number" defaultValue={agent.tinNumber ?? ""} />
            <Field name="designation" label="Designation" defaultValue={agent.designation ?? ""} />
            <Field name="joinedOn" label="Joined on" type="date" defaultValue={ymd(agent.joinedOn)} />
            <div className="sm:col-span-3">
              <Field name="address" label="Address" defaultValue={agent.address ?? ""} />
            </div>
            <div className="sm:col-span-3">
              <Field name="notes" label="Notes (internal)" defaultValue={agent.notes ?? ""} />
            </div>
          </div>

          {agent.userId ? (
            <p className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
              <strong>Changing the email does not move their login by itself.</strong> This agent
              already signs in as <code className="font-mono">{agent.profile?.email ?? "—"}</code>.
              After saving a new email, go back to the agent and click{" "}
              <strong>Resend invite</strong> — that provisions the new address, re-points the
              agent to it, and revokes agent access from the old one. Until you do, they keep
              signing in with the old address.
            </p>
          ) : (
            <p className="mt-3 text-xs text-zinc-500">
              This agent has no login yet — the email set here is the address that will be
              invited when they are approved.
            </p>
          )}

          <button
            type="submit"
            className="mt-3 rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
          >
            Save profile
          </button>
        </form>
      </Section>

      {/* ── Bank accounts ─────────────────────────────────────────── */}
      <Section title="Bank accounts">
        <p className="text-xs text-zinc-600 dark:text-zinc-400">
          Commission payouts settle to the <strong>primary</strong> account.
        </p>

        {agent.bankAccounts.length === 0 ? (
          <p className="mt-3 text-sm text-zinc-500">No bank account on file yet.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {agent.bankAccounts.map((b) => (
              <li
                key={b.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-zinc-200 px-3 py-2 dark:border-zinc-800"
              >
                <div className="text-sm">
                  <p className="font-medium text-zinc-900 dark:text-zinc-100">
                    {b.bankName}
                    {b.isPrimary && (
                      <span className="ml-2 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                        Primary
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-zinc-500">
                    {[b.branchName, `A/C: ${b.accountNumber}`].filter(Boolean).join(" · ")}
                    {b.routingNumber ? ` · Routing: ${b.routingNumber}` : ""}
                    {b.accountName ? ` · ${b.accountName}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {!b.isPrimary && (
                    <form action={setPrimaryAgentBank}>
                      <input type="hidden" name="agentId" value={agent.id} />
                      <input type="hidden" name="bankId" value={b.id} />
                      <button className="rounded-md border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-700">
                        Make primary
                      </button>
                    </form>
                  )}
                  {isAdmin && (
                    <form
                      action={deleteAgentBankAccount}
                      data-confirm={`Remove ${b.bankName} A/C ${b.accountNumber}?`}
                    >
                      <input type="hidden" name="agentId" value={agent.id} />
                      <input type="hidden" name="bankId" value={b.id} />
                      <button className="rounded-md border border-red-300 px-2 py-1 text-xs text-red-700 dark:border-red-900 dark:text-red-300">
                        Remove
                      </button>
                    </form>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        <form action={addAgentBankAccount} className="mt-4 border-t border-zinc-200 pt-4 dark:border-zinc-800">
          <input type="hidden" name="agentId" value={agent.id} />
          <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
            Add bank account
          </p>
          <div className="mt-2 grid gap-3 sm:grid-cols-3">
            <Field name="bankName" label="Bank name" required />
            <Field name="branchName" label="Branch" />
            <Field name="accountName" label="Account name" />
            <Field name="accountNumber" label="Account number" required />
            <Field name="routingNumber" label="Routing number" />
          </div>
          <button
            type="submit"
            className="mt-3 rounded-md border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700"
          >
            Add account
          </button>
        </form>
      </Section>

      {/* ── Nominee ───────────────────────────────────────────────── */}
      <Section title="Nominee">
        {agent.nominees.length === 0 ? (
          <p className="text-sm text-zinc-500">No nominee on file yet.</p>
        ) : (
          <ul className="space-y-2">
            {agent.nominees.map((n) => (
              <li
                key={n.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-zinc-200 px-3 py-2 dark:border-zinc-800"
              >
                <div className="text-sm">
                  <p className="font-medium text-zinc-900 dark:text-zinc-100">{n.name}</p>
                  <p className="text-xs text-zinc-500">
                    {[n.relationship, n.nidNumber ? `NID: ${n.nidNumber}` : null, ymd(n.dateOfBirth) || null]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-mono text-sm tabular-nums">{Number(n.share)}%</span>
                  {isAdmin && (
                    <form action={deleteAgentNominee} data-confirm={`Remove nominee ${n.name}?`}>
                      <input type="hidden" name="agentId" value={agent.id} />
                      <input type="hidden" name="nomineeId" value={n.id} />
                      <button className="rounded-md border border-red-300 px-2 py-1 text-xs text-red-700 dark:border-red-900 dark:text-red-300">
                        Remove
                      </button>
                    </form>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        {nomineeShareUsed < 100 && (
          <form action={addAgentNominee} className="mt-4 border-t border-zinc-200 pt-4 dark:border-zinc-800">
            <input type="hidden" name="agentId" value={agent.id} />
            <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              Add nominee — {100 - nomineeShareUsed}% unallocated
            </p>
            <div className="mt-2 grid gap-3 sm:grid-cols-3">
              <Field name="name" label="Name" required />
              <Field name="relationship" label="Relationship" placeholder="Spouse" />
              <Field name="nidNumber" label="NID number" />
              <Field name="dateOfBirth" label="Date of birth" type="date" />
              <Field
                name="share"
                label="Share (%)"
                type="number"
                defaultValue={String(100 - nomineeShareUsed)}
              />
              <div className="sm:col-span-3">
                <Field name="address" label="Address" />
              </div>
            </div>
            <button
              type="submit"
              className="mt-3 rounded-md border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700"
            >
              Add nominee
            </button>
          </form>
        )}
      </Section>

      {/* ── Documents ─────────────────────────────────────────────── */}
      <Section title="Documents">
        <p className="text-xs text-zinc-600 dark:text-zinc-400">
          Registration form, cheque leaf, photograph and NID for the agent, plus the nominee's
          photograph and NID. Links below are signed and expire in 5 minutes.
        </p>

        <div className="mt-4 space-y-4">
          {AGENT_DOC_GROUPS.map((group) => (
            <div key={group.title}>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                {group.title}
              </p>
              <ul className="mt-2 divide-y divide-zinc-200 dark:divide-zinc-800">
                {group.types.map((type) => (
                  <DocRow
                    key={type}
                    type={type}
                    doc={latestByType.get(type)}
                    url={latestByType.get(type) ? urlById.get(latestByType.get(type)!.id) ?? null : null}
                    agentId={agent.id}
                    canDelete={isAdmin}
                  />
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-6 border-t border-zinc-200 pt-4 dark:border-zinc-800">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
            Upload documents
          </p>
          <DocumentUploadForm agentId={agent.id} />
        </div>
      </Section>
    </main>
  );
}

function DocRow({
  type,
  doc,
  url,
  agentId,
  canDelete,
}: {
  type: AgentDocType;
  doc?: { id: string; fileName: string; createdAt: Date };
  url: string | null;
  agentId: string;
  canDelete: boolean;
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm">
      <span className="text-zinc-700 dark:text-zinc-300">{AGENT_DOC_LABELS[type]}</span>
      {doc ? (
        <span className="flex items-center gap-3">
          <span className="text-xs text-zinc-500">
            {doc.createdAt.toISOString().slice(0, 10)}
          </span>
          {url ? (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="max-w-[16rem] truncate font-medium underline underline-offset-2"
            >
              {doc.fileName}
            </a>
          ) : (
            <span className="text-xs text-amber-700 dark:text-amber-400">
              {doc.fileName} (link unavailable)
            </span>
          )}
          {canDelete && (
            <form action={deleteAgentDocument} data-confirm={`Remove ${AGENT_DOC_LABELS[type]}?`}>
              <input type="hidden" name="agentId" value={agentId} />
              <input type="hidden" name="docId" value={doc.id} />
              <button className="text-xs text-red-700 underline underline-offset-2 dark:text-red-300">
                Remove
              </button>
            </form>
          )}
        </span>
      ) : (
        <span className="text-xs text-zinc-400">Not uploaded</span>
      )}
    </li>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Field({
  name,
  label,
  type = "text",
  defaultValue,
  placeholder,
  required = false,
}: {
  name: string;
  label: string;
  type?: string;
  defaultValue?: string;
  placeholder?: string;
  required?: boolean;
}) {
  return (
    <label className="block">
      <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
        {label}
        {required && <span className="text-red-500"> *</span>}
      </span>
      <input
        type={type}
        name={name}
        defaultValue={defaultValue}
        placeholder={placeholder}
        required={required}
        className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
      />
    </label>
  );
}
