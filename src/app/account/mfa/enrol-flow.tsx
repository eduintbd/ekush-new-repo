"use client";

// Enrol-a-new-authenticator wizard. Three states:
//   idle → user clicks "Begin enrolment"
//   showing → QR + secret are shown, user scans + enters code
//   verifying → 6-digit code submitted, server-action verifies + redirects

import { useState, useTransition } from "react";
import { enrolTotp, unenrol, verifyEnrolment } from "./actions";

type UnverifiedFactor = { id: string; friendlyName: string | null; createdAt: string };

export function EnrolFlow({
  unverifiedFactors,
}: {
  unverifiedFactors: UnverifiedFactor[];
}) {
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "showing"; factorId: string; qrCodeSvg: string; secret: string; uri: string }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  const [pending, startTransition] = useTransition();

  const begin = () =>
    startTransition(async () => {
      const result = await enrolTotp();
      if (result.ok) {
        setState({
          kind: "showing",
          factorId: result.factorId,
          qrCodeSvg: result.qrCodeSvg,
          secret: result.secret,
          uri: result.uri,
        });
      } else {
        setState({ kind: "error", message: result.error });
      }
    });

  if (state.kind === "idle") {
    return (
      <div className="mt-3 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <p className="text-sm text-zinc-700 dark:text-zinc-300">
          Use an authenticator app such as 1Password, Google Authenticator, or Authy.
          You will see a QR code to scan and a one-time-password field to verify.
        </p>
        {unverifiedFactors.length > 0 && (
          <UnverifiedNotice factors={unverifiedFactors} />
        )}
        <button
          type="button"
          onClick={begin}
          disabled={pending}
          className="mt-4 rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          {pending ? "Starting…" : "Begin enrolment"}
        </button>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="mt-3 rounded-lg border border-red-300 bg-red-50 p-5 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
        <p className="font-medium">Could not start enrolment</p>
        <p className="mt-1 text-xs">{state.message}</p>
        <button
          type="button"
          onClick={() => setState({ kind: "idle" })}
          className="mt-3 rounded-md border border-red-300 px-3 py-1 text-xs font-medium hover:bg-red-100 dark:hover:bg-red-900"
        >
          Try again
        </button>
      </div>
    );
  }

  // Supabase already returns `qr_code` as a complete data: URI. Use as-is.
  const qrSrc = state.qrCodeSvg;
  return (
    <div className="mt-3 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <ol className="space-y-4 text-sm text-zinc-700 dark:text-zinc-300">
        <li>
          <p className="font-medium">1. Scan the QR code in your authenticator app.</p>
          <div className="mt-3 inline-block rounded-md border border-zinc-200 bg-white p-2 dark:border-zinc-800 dark:bg-zinc-950">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qrSrc} alt="Authenticator QR code" width={180} height={180} />
          </div>
        </li>
        <li>
          <p className="font-medium">2. Or enter this secret manually:</p>
          <code className="mt-2 block break-all rounded-md bg-zinc-100 px-3 py-2 font-mono text-xs dark:bg-zinc-800">
            {state.secret}
          </code>
        </li>
        <li>
          <p className="font-medium">3. Enter the 6-digit code your app generates:</p>
          <div className="mt-3 flex items-center gap-2">
            <form action={verifyEnrolment} className="flex items-center gap-2">
              <input type="hidden" name="factorId" value={state.factorId} />
              <input
                type="text"
                name="code"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                placeholder="123456"
                autoComplete="one-time-code"
                required
                className="w-32 rounded-md border border-zinc-300 px-3 py-2 text-center font-mono text-base tracking-widest focus:border-zinc-900 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:focus:border-zinc-100"
              />
              <button
                type="submit"
                className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
              >
                Verify
              </button>
            </form>
            <form action={unenrol} className="ml-auto">
              <input type="hidden" name="factorId" value={state.factorId} />
              <button
                type="submit"
                className="rounded-md border border-zinc-300 px-3 py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                Cancel
              </button>
            </form>
          </div>
        </li>
      </ol>
    </div>
  );
}

function UnverifiedNotice({ factors }: { factors: UnverifiedFactor[] }) {
  return (
    <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
      <p>
        You have {factors.length} unverified enrolment{factors.length === 1 ? "" : "s"} from a
        previous attempt. Remove them or start a new enrolment alongside.
      </p>
      <ul className="mt-2 space-y-1">
        {factors.map((f) => (
          <li key={f.id} className="flex items-center justify-between gap-3">
            <span className="font-mono">
              {f.friendlyName ?? "Authenticator"}{" "}
              <span className="text-amber-700/70 dark:text-amber-300/60">
                · {new Date(f.createdAt).toISOString().slice(0, 10)}
              </span>
            </span>
            <form action={unenrol}>
              <input type="hidden" name="factorId" value={f.id} />
              <button
                type="submit"
                className="rounded-md border border-amber-400 px-2 py-0.5 text-[11px] font-medium hover:bg-amber-100 dark:border-amber-700 dark:hover:bg-amber-900"
              >
                Remove
              </button>
            </form>
          </li>
        ))}
      </ul>
    </div>
  );
}
