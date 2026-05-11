"use client";

import { useState, useTransition } from "react";
import { generateRecoveryCodesAction } from "./actions";

export function RecoveryCodesSection({ existingCount }: { existingCount: number }) {
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [confirmed, setConfirmed] = useState(false);

  const generate = () => {
    setError(null);
    setCodes(null);
    setConfirmed(false);
    startTransition(async () => {
      const result = await generateRecoveryCodesAction();
      if (result.ok) {
        setCodes(result.codes);
      } else {
        setError(result.error);
      }
    });
  };

  const copyAll = async () => {
    if (!codes) return;
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
    } catch {
      // Older browsers / insecure contexts — ignore; user can select manually.
    }
  };

  const download = () => {
    if (!codes) return;
    const blob = new Blob(
      [`Ekush ERP — recovery codes (generated ${new Date().toISOString()})\n\n` + codes.join("\n") + "\n"],
      { type: "text/plain" },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ekush-erp-recovery-codes-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="mt-8">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">
        Recovery codes
      </h2>
      <p className="mt-2 text-xs text-zinc-500">
        Single-use codes that let you regain access if you lose your authenticator.
        Each code works once. {existingCount > 0 && `You have ${existingCount} unused code${existingCount === 1 ? "" : "s"} on file.`}
      </p>

      {codes === null ? (
        <button
          type="button"
          onClick={generate}
          disabled={pending}
          className="mt-4 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          {pending
            ? "Generating…"
            : existingCount > 0
              ? "Regenerate recovery codes"
              : "Generate recovery codes"}
        </button>
      ) : (
        <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950">
          <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">
            Save these codes now. They will not be shown again.
          </p>
          <ul className="mt-3 grid grid-cols-2 gap-2 font-mono text-sm text-amber-900 dark:text-amber-200">
            {codes.map((c, i) => (
              <li key={c} className="rounded bg-white/60 px-2 py-1 text-center dark:bg-zinc-900/60">
                <span className="mr-2 text-xs text-amber-700 dark:text-amber-300">{i + 1}.</span>
                {c}
              </li>
            ))}
          </ul>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={copyAll}
              className="rounded-md bg-amber-900 px-3 py-1.5 text-xs font-medium text-amber-50 hover:bg-amber-800"
            >
              Copy all
            </button>
            <button
              type="button"
              onClick={download}
              className="rounded-md border border-amber-400 bg-white px-3 py-1.5 text-xs font-medium text-amber-900 hover:bg-amber-100 dark:bg-zinc-900 dark:text-amber-200 dark:hover:bg-zinc-800"
            >
              Download .txt
            </button>
          </div>
          <label className="mt-4 flex items-center gap-2 text-xs text-amber-900 dark:text-amber-200">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              className="rounded border-amber-400"
            />
            I have saved these codes somewhere safe.
          </label>
          {confirmed && (
            <button
              type="button"
              onClick={() => setCodes(null)}
              className="mt-3 text-xs text-amber-900 underline hover:text-amber-700 dark:text-amber-200 dark:hover:text-amber-100"
            >
              Done — hide codes
            </button>
          )}
        </div>
      )}

      {error && (
        <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>
      )}
    </section>
  );
}
