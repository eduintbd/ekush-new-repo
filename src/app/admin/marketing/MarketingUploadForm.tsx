"use client";

// Admin uploads one marketing file (title + category + jpg/png/webp/pdf).
// Multipart POST to /api/admin/marketing, same client-fetch pattern as the
// agent document uploader.

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { MARKETING_CATEGORIES, MARKETING_LABELS } from "@/lib/marketing-contents";

export default function MarketingUploadForm() {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/admin/marketing", {
        method: "POST",
        body: new FormData(e.currentTarget),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(body.error ?? `Upload failed (${res.status}).`);
        return;
      }
      formRef.current?.reset();
      setFileName("");
      router.refresh();
    } catch {
      setError("Upload failed — check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form ref={formRef} onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-[1fr_180px]">
      {error && (
        <p className="sm:col-span-2 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          {error}
        </p>
      )}
      <label className="block">
        <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">Title</span>
        <input
          name="title"
          required
          placeholder="e.g. EFUF fund flyer — July 2026"
          className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
      </label>
      <label className="block">
        <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">Category</span>
        <select
          name="category"
          className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        >
          {MARKETING_CATEGORIES.map((c) => (
            <option key={c} value={c}>{MARKETING_LABELS[c]}</option>
          ))}
        </select>
      </label>

      <label className="sm:col-span-2 block cursor-pointer rounded-md border border-dashed border-zinc-300 px-3 py-2 transition-colors hover:border-zinc-500 dark:border-zinc-700 dark:hover:border-zinc-500">
        <span className="block text-xs font-medium text-zinc-700 dark:text-zinc-300">
          {fileName || "Choose a file — JPG / PNG / WEBP up to 5 MB, or PDF up to 10 MB"}
        </span>
        <input
          type="file"
          name="file"
          required
          accept=".jpg,.jpeg,.png,.webp,.pdf"
          className="hidden"
          onChange={(e) => setFileName(e.currentTarget.files?.[0]?.name ?? "")}
        />
      </label>

      <div className="sm:col-span-2">
        <button
          type="submit"
          disabled={busy || !fileName}
          className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
        >
          {busy ? "Uploading…" : "Upload content"}
        </button>
      </div>
    </form>
  );
}
