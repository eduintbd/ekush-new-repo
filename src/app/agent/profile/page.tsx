// /agent/profile — the selling agent's own profile record, read-only.
//
// Read-only by design: an agent's code, NID, bank account and documents
// are what commissions are paid against, so they are maintained by the
// AMC in /admin/agents/[id]/profile. Corrections go through the same
// people who approved the agent — the page says so rather than silently
// offering no way forward.

import Link from "next/link";
import { getAgentScope } from "@/lib/agent-scope";
import { prisma } from "@/lib/prisma";
import { signedKycUrls } from "@/lib/kyc-files";
import { AGENT_DOC_GROUPS, AGENT_DOC_LABELS, type AgentDocType } from "@/lib/agent-documents";

function ymd(d: Date | null | undefined): string {
  return d ? d.toISOString().slice(0, 10) : "—";
}

export default async function AgentProfilePage() {
  const scope = await getAgentScope();

  if (!scope.agentId) {
    return (
      <main className="mx-auto w-full max-w-3xl px-6 py-10">
        <BackLink />
        <h1 className="mt-3 text-2xl font-semibold tracking-tight">My profile</h1>
        <p className="mt-4 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          Your sign-in isn&apos;t linked to a selling-agent record yet — contact admin.
        </p>
      </main>
    );
  }

  const agent = await prisma.sellingAgent.findUnique({
    where: { id: scope.agentId },
    include: {
      bankAccounts: { orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }] },
      nominees: { orderBy: { createdAt: "asc" } },
      documents: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!agent) {
    return (
      <main className="mx-auto w-full max-w-3xl px-6 py-10">
        <BackLink />
        <p className="mt-4 text-sm text-zinc-500">Profile not found.</p>
      </main>
    );
  }

  const signed = await signedKycUrls(agent.documents.map((d) => d.filePath));
  const urlById = new Map(agent.documents.map((d, i) => [d.id, signed[i]]));

  const latestByType = new Map<string, (typeof agent.documents)[number]>();
  for (const doc of agent.documents) {
    if (!latestByType.has(doc.type)) latestByType.set(doc.type, doc);
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-10">
      <BackLink />
      <h1 className="mt-3 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
        My profile
      </h1>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
        Maintained by Ekush WML. Something wrong or out of date? Email{" "}
        <a href="mailto:info@ekushwml.com" className="underline underline-offset-2">
          info@ekushwml.com
        </a>{" "}
        with your agent code and we&apos;ll correct it.
      </p>

      <Card title="Account information">
        <Row label="Agent code" value={agent.code} mono />
        <Row label="Name" value={[agent.title, agent.fullName].filter(Boolean).join(" ")} />
        <Row label="Status" value={agent.status} />
        <Row label="Designation" value={agent.designation ?? "—"} />
        <Row label="Joined on" value={ymd(agent.joinedOn)} />
      </Card>

      <Card title="Contact details">
        <Row label="Email" value={agent.email} />
        <Row label="Phone" value={agent.phone ?? "—"} />
        <Row label="Address" value={agent.address ?? "—"} />
      </Card>

      <Card title="Personal details">
        <Row label="Father's name" value={agent.fatherName ?? "—"} />
        <Row label="Date of birth" value={ymd(agent.dateOfBirth)} />
        <Row label="NID number" value={agent.nidNumber ?? "—"} mono />
        <Row label="TIN number" value={agent.tinNumber ?? "—"} mono />
      </Card>

      <Card title="Bank accounts">
        {agent.bankAccounts.length === 0 ? (
          <p className="text-sm text-zinc-500">No bank account on file.</p>
        ) : (
          <ul className="space-y-2">
            {agent.bankAccounts.map((b) => (
              <li key={b.id} className="rounded-md bg-zinc-100 px-3 py-2 dark:bg-zinc-800">
                <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                  {b.bankName}
                  {b.isPrimary && (
                    <span className="ml-2 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                      Primary
                    </span>
                  )}
                </p>
                <p className="mt-0.5 text-xs text-zinc-500">
                  {[b.branchName, `A/C: ${b.accountNumber}`].filter(Boolean).join(" · ")}
                  {b.routingNumber ? ` · Routing: ${b.routingNumber}` : ""}
                </p>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-zinc-500">
          Commissions are paid to the primary account. To change it, contact us — bank details
          are only updated against a fresh cheque leaf.
        </p>
      </Card>

      <Card title="Nominee">
        {agent.nominees.length === 0 ? (
          <p className="text-sm text-zinc-500">No nominee on file.</p>
        ) : (
          <ul className="space-y-2">
            {agent.nominees.map((n) => (
              <li
                key={n.id}
                className="flex items-center justify-between rounded-md bg-zinc-100 px-3 py-2 dark:bg-zinc-800"
              >
                <div>
                  <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{n.name}</p>
                  <p className="text-xs text-zinc-500">{n.relationship ?? "—"}</p>
                </div>
                <span className="font-mono text-sm tabular-nums">{Number(n.share)}%</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Documents">
        <div className="space-y-4">
          {AGENT_DOC_GROUPS.map((group) => (
            <div key={group.title}>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                {group.title}
              </p>
              <ul className="mt-1 divide-y divide-zinc-200 dark:divide-zinc-800">
                {group.types.map((type) => {
                  const doc = latestByType.get(type);
                  const url = doc ? urlById.get(doc.id) ?? null : null;
                  return (
                    <li
                      key={type}
                      className="flex items-center justify-between gap-3 py-2 text-sm"
                    >
                      <span className="text-zinc-700 dark:text-zinc-300">
                        {AGENT_DOC_LABELS[type as AgentDocType]}
                      </span>
                      {doc && url ? (
                        <a
                          href={url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="max-w-[14rem] truncate font-medium underline underline-offset-2"
                        >
                          {doc.fileName}
                        </a>
                      ) : (
                        <span className="text-xs text-zinc-400">
                          {doc ? "Link unavailable" : "Not on file"}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs text-zinc-500">
          Document links are private and expire after 5 minutes — reload this page to open one
          again.
        </p>
      </Card>
    </main>
  );
}

function BackLink() {
  return (
    <Link
      href="/agent"
      className="text-xs uppercase tracking-widest text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
    >
      ← Dashboard
    </Link>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-6 rounded-lg border border-emerald-200 bg-white p-5 dark:border-emerald-900 dark:bg-zinc-900">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-zinc-100 py-2 last:border-0 dark:border-zinc-800">
      <span className="text-xs text-zinc-500">{label}</span>
      <span
        className={`text-right text-sm text-zinc-900 dark:text-zinc-100 ${mono ? "font-mono" : ""}`}
      >
        {value || "—"}
      </span>
    </div>
  );
}
