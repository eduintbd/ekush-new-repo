"use client";

// Multi-file upload panel for a selling agent's profile documents. Posts
// to /api/admin/agents/[id]/documents as multipart — a server action
// can't carry the files, and this repo already uses client fetch for the
// one other upload path (agent/investors/new).

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import {
  AGENT_DOC_GROUPS,
  AGENT_DOC_LABELS,
  AGENT_PDF_ALLOWED,
  type AgentDocType,
} from "@/lib/agent-documents";

export default function DocumentUploadForm({ agentId }: { agentId: string }) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Record<string, string>>({});

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/agents/${agentId}/documents`, {
        method: "POST",
        body: new FormData(e.currentTarget),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; count?: number };
      if (!res.ok) {
        setError(body.error ?? `Upload failed (${res.status}).`);
        return;
      }
      formRef.current?.reset();
      setChosen({});
      router.refresh();
    } catch {
      setError("Upload failed — check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  const anyChosen = Object.values(chosen).some(Boolean);

  return (
    <form ref={formRef} onSubmit={onSubmit} className="mt-4">
      {error && (
        <p className="mb-3 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          {error}
        </p>
      )}

      <div className="space-y-5">
        {AGENT_DOC_GROUPS.map((group) => (
          <div key={group.title}>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              {group.title}
            </p>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              {group.types.map((type) => (
                <FilePicker
                  key={type}
                  type={type}
                  chosenName={chosen[type]}
                  onChoose={(name) => setChosen((c) => ({ ...c, [type]: name }))}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button
          type="submit"
          disabled={busy || !anyChosen}
          className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
        >
          {busy ? "Uploading…" : "Upload selected"}
        </button>
        <p className="text-xs text-zinc-500">
          JPEG / PNG / WEBP up to 5 MB. PDF (up to 10 MB) only for the registration form,
          cheque leaf and NID scans. Images are re-encoded and stripped of EXIF/GPS on upload.
        </p>
      </div>
    </form>
  );
}

function FilePicker({
  type,
  chosenName,
  onChoose,
}: {
  type: AgentDocType;
  chosenName?: string;
  onChoose: (name: string) => void;
}) {
  const allowsPdf = AGENT_PDF_ALLOWED.has(type);
  return (
    <label className="block cursor-pointer rounded-md border border-dashed border-zinc-300 px-3 py-2 transition-colors hover:border-zinc-500 dark:border-zinc-700 dark:hover:border-zinc-500">
      <span className="block text-xs font-medium text-zinc-700 dark:text-zinc-300">
        {AGENT_DOC_LABELS[type]}
      </span>
      <span className="mt-0.5 block truncate text-[11px] text-zinc-500">
        {chosenName ?? (allowsPdf ? "Image or PDF" : "Image only")}
      </span>
      <input
        type="file"
        name={type}
        accept={allowsPdf ? ".jpg,.jpeg,.png,.webp,.pdf" : ".jpg,.jpeg,.png,.webp"}
        className="hidden"
        onChange={(e) => onChoose(e.currentTarget.files?.[0]?.name ?? "")}
      />
    </label>
  );
}
