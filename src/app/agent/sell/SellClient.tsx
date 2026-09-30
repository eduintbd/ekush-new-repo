"use client";

// The agent-side Sell Fund wizard. Steps, wording and rules follow the
// investor's own sell flow at apps/portal/src/app/(portal)/transactions/sell/
// page.tsx, so a client's redemption goes through the same process whoever
// raises it:
//
//   Information -> [BO Withdrawal Form, only for a BO holder in a BO fund]
//               -> Authorisation -> Confirm -> Success
//
// Two things differ, as on Buy Fund: an investor picker (with search) on the
// first step, and an Authorisation step where the agent attaches the client's
// written instruction to sell — the agent's authority to act for them.
//
// OpenBoSells, below, lists BO sells waiting on a DP-40 so the agent can
// upload it (the investor can also do so from their portal) or cancel one
// they placed.

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { SellInvestorOption } from "@/lib/agent-sell";
import { unitsForRequest } from "@/lib/units";
import { InvestorSearchSelect } from "@/components/investor-search-select";
import { UPLOAD_ATTEMPTS, uploadKycDocument, type UploadedRef } from "@/lib/kyc-direct-upload";

// Funds whose units sit in a BO account — mirrors FUND_CDBL_DETAILS.
const BO_FUNDS = new Set(["EFUF", "EGF", "ESRF"]);

// One order posts as one multipart body; a Vercel function caps it at 4.5 MB.
const MAX_BYTES = 4 * 1024 * 1024;

function bdt(n: number, decimals = 2): string {
  return n.toLocaleString("en-IN", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
const whole = (n: number) => Math.floor(n + 1e-6).toLocaleString("en-IN");
function mb(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

type Done = {
  orderId: string;
  status: string;
  investorCode: string;
  fundCode: string;
  fundName: string;
  units: number;
  nav: number;
  estimatedAmount: number;
  requiresBoWithdrawal: boolean;
  message: string;
};

export function SellClient({
  investors,
  agentCode,
}: {
  investors: SellInvestorOption[];
  agentCode: string;
}) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [investorCode, setInvestorCode] = useState(investors[0]?.investorCode ?? "");
  const [fundCode, setFundCode] = useState("");
  const [unitsRaw, setUnitsRaw] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [instruction, setInstruction] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  // The client's authorisation once it is safely in storage, so a retry after
  // a failed submit does not upload it a second time. The File is kept beside
  // the key so a swapped attachment is noticed rather than silently ignored.
  const sentInstruction = useRef<{ ref: UploadedRef; file: File } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadRetry, setUploadRetry] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);

  const investor = investors.find((i) => i.investorCode === investorCode) ?? null;
  const holding = investor?.holdings.find((h) => h.fundCode === fundCode) ?? null;
  const sellable = holding?.sellableUnits ?? 0;
  const nav = holding?.nav ?? 0;
  const avgCost = holding?.avgCost ?? 0;
  const typed = parseFloat(unitsRaw) || 0;
  // Whole units, never above the sellable balance — same rule as the server.
  const unitsNum = unitsForRequest(typed, sellable);
  const estimatedAmount = unitsNum * nav;
  const estimatedGain = unitsNum * (nav - avgCost);

  const needsBoStep = !!investor?.bo.hasBoId && BO_FUNDS.has(fundCode);
  // A BO ID that is present but unusable must block, never fall through to
  // the non-demat path.
  const boBlocked = needsBoStep && !investor?.bo.dpKnown;

  const steps = needsBoStep
    ? ["Information", "BO Withdrawal Form", "Authorisation", "Confirm", "Success"]
    : ["Information", "Authorisation", "Confirm", "Success"];
  const authStep = needsBoStep ? 2 : 1;
  const confirmStep = needsBoStep ? 3 : 2;
  const successStep = needsBoStep ? 4 : 3;

  const previewFormHref =
    investor && fundCode && unitsNum > 0
      ? `/api/agent/sell/bo-form?${new URLSearchParams({
          investorCode: investor.investorCode,
          fundCode,
          units: String(unitsNum),
        }).toString()}`
      : "";

  function reset(keepInvestor = true) {
    setDone(null);
    setStep(0);
    if (!keepInvestor) setInvestorCode(investors[0]?.investorCode ?? "");
    setFundCode("");
    setUnitsRaw("");
    setAcknowledged(false);
    setInstruction(null);
    // A different order — its authorisation is its own.
    sentInstruction.current = null;
    setError(null);
  }

  async function submit() {
    if (!investor || !holding || unitsNum <= 0 || !instruction) return;
    if (busyRef.current) return; // a double-click can only send once
    busyRef.current = true;
    setBusy(true);
    setError(null);

    // The authorisation goes STRAIGHT to storage, with its own retries, rather
    // than riding inside this POST — the same all-or-nothing delivery that was
    // costing agents whole onboarding registrations on a weak link. Kept in a
    // ref so pressing Submit again after a failure does not re-send it.
    if (sentInstruction.current?.file !== instruction) {
      setUploading(true);
      try {
        sentInstruction.current = {
          ref: await uploadKycDocument(instruction, (attempt) => setUploadRetry(attempt)),
          file: instruction,
        };
        setUploadRetry(null);
      } catch (e) {
        setUploading(false);
        setUploadRetry(null);
        busyRef.current = false;
        setBusy(false);
        setError(
          `The client's authorisation could not be uploaded (${
            e instanceof Error ? e.message : "upload failed"
          }). Nothing was saved — check you are online and submit again.`,
        );
        return;
      }
      setUploading(false);
    }

    let res: Response;
    try {
      res = await fetch("/api/agent/sell", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          investorCode: investor.investorCode,
          fundCode,
          units: unitsNum,
          documents: { instruction: sentInstruction.current?.ref },
        }),
      });
    } catch (e) {
      busyRef.current = false;
      setBusy(false);
      setError(
        `The order could not be sent — the connection dropped before the server answered (${
          e instanceof Error ? e.message : "network error"
        }). Nothing was saved. Check you are online and try again.`,
      );
      return;
    }
    const raw = await res.text().catch(() => "");
    let data: (Partial<Done> & { ok?: boolean; error?: string }) | null = null;
    try {
      data = JSON.parse(raw);
    } catch {
      /* handled below */
    }
    busyRef.current = false;
    setBusy(false);

    if (!res.ok || !data?.ok) {
      setError(data?.error ?? `The server answered HTTP ${res.status} with no reason given. Nothing was saved.`);
      setStep(0);
      return;
    }
    setDone(data as Done);
    setStep(successStep);
    router.refresh(); // the new BO sell appears in the list below
  }

  // ───────────────────────── Success ─────────────────────────
  if (done) {
    return (
      <div className="space-y-5">
        <Stepper steps={steps} current={successStep} />
        <div className="rounded-lg border border-emerald-300 bg-white p-6 dark:border-emerald-800 dark:bg-zinc-900">
          <h2 className="text-xl font-semibold text-emerald-800 dark:text-emerald-300">
            {done.requiresBoWithdrawal ? "Redemption Placed — Not Yet Executed" : "Redemption Submitted ✓"}
          </h2>
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">{done.message}</p>

          <dl className="mt-4 grid gap-2 rounded-md border border-zinc-200 p-4 text-sm dark:border-zinc-800">
            <Row label="Investor" value={`${done.investorCode} — ${investor?.name ?? ""}`} />
            <Row label="Fund" value={`${done.fundName} (${done.fundCode})`} />
            <Row label="Units" value={Math.round(done.units).toLocaleString("en-IN")} />
            <Row label="Est. Amount" value={bdt(done.estimatedAmount)} />
            <Row label="Status" value={done.requiresBoWithdrawal ? "Awaiting DP-40" : "Pending approval"} />
          </dl>

          {done.requiresBoWithdrawal && (
            <div className="mt-4 flex flex-col gap-2 text-sm">
              <a
                href={`/api/agent/sell/bo-form?orderId=${encodeURIComponent(done.orderId)}`}
                className="font-medium text-emerald-700 hover:underline dark:text-emerald-400"
              >
                ↓ Download the BO Units Withdrawal form again
              </a>
              <a
                href={`/agent/forms/sell-order?orderId=${encodeURIComponent(done.orderId)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-emerald-700 hover:underline dark:text-emerald-400"
              >
                ↗ Download the sell order form
              </a>
            </div>
          )}

          <p className="mt-4 text-xs text-zinc-500 dark:text-zinc-400">
            {done.requiresBoWithdrawal
              ? "The office sees this on BO Withdrawals. It reaches the approvals queue once the DP-40 is uploaded — below, or by the investor in their portal."
              : "The office sees this on the approvals queue with your agent code against it."}{" "}
            The investor is emailed and messaged on WhatsApp only once it is approved — nothing is sent before that.
          </p>

          <div className="mt-5 flex flex-wrap gap-3">
            <button
              onClick={() => reset(true)}
              className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 dark:border-zinc-700 dark:text-zinc-300"
            >
              Place Another
            </button>
            <Link
              href="/agent"
              className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 dark:border-zinc-700 dark:text-zinc-300"
            >
              Back to dashboard
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <Stepper steps={steps} current={step} />

      {uploading && (
        <p
          role="status"
          className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200"
        >
          Uploading the client&apos;s authorisation… it is sent on its own, so a dropped connection
          only costs this one file.
        </p>
      )}

      {uploadRetry !== null && (
        <p
          role="status"
          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
        >
          The connection dropped while sending the authorisation. Trying again — attempt{" "}
          {uploadRetry} of {UPLOAD_ATTEMPTS}. Stay on this page.
        </p>
      )}

      {error && (
        <p
          role="alert"
          className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
        >
          {error}
        </p>
      )}

      {/* ───── Information ───── */}
      {step === 0 && (
        <Card title="Redemption Information">
          <Field label="Investor" htmlFor="sell-investor">
            <InvestorSearchSelect
              id="sell-investor"
              options={investors.map((i) => ({ code: i.investorCode, label: `${i.investorCode} — ${i.name}` }))}
              value={investorCode}
              onChange={(c) => {
                setInvestorCode(c);
                setFundCode("");
                setUnitsRaw("");
                setAcknowledged(false);
              }}
            />
            {investor && (
              <p className="mt-1 text-[11px] text-zinc-500">
                {investor.bo.hasBoId ? `BO ID ${investor.bo.boId}` : "No BO account (non-demat)"}
                {investor.via === "onboarded" ? " · onboarded by you" : " · your client"}
              </p>
            )}
          </Field>

          <Field label="Fund">
            <select
              value={fundCode}
              onChange={(e) => {
                setFundCode(e.target.value);
                setUnitsRaw("");
                setAcknowledged(false);
              }}
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:[color-scheme:dark]"
            >
              <option value="">Please select a fund</option>
              {investor?.holdings.map((h) => (
                <option key={h.fundCode} value={h.fundCode}>
                  {h.fundCode} - {h.fundName}
                </option>
              ))}
            </select>
          </Field>

          {holding && (
            <dl className="grid gap-2 rounded-md bg-zinc-50 p-4 text-sm dark:bg-zinc-950">
              {holding.heldUnits > 0 && (
                <Row label="Units on Hold (sale pending DP-40)" value={`-${whole(holding.heldUnits)}`} />
              )}
              <Row label="Sellable Units" value={whole(sellable)} />
              <Row label="Current NAV" value={bdt(nav, 4)} />
              <Row label="Avg Cost" value={bdt(avgCost, 4)} />
            </dl>
          )}

          <Field label="Units to Redeem" accent>
            <input
              type="number"
              min="1"
              step="1"
              max={Math.floor(sellable + 1e-6)}
              value={unitsRaw}
              onChange={(e) => {
                setUnitsRaw(e.target.value);
                setAcknowledged(false);
              }}
              placeholder="Enter number of units"
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 font-mono text-sm dark:border-zinc-700 dark:bg-zinc-950"
            />
          </Field>
          {sellable >= 1 && (
            <button
              type="button"
              onClick={() => {
                setUnitsRaw(String(Math.floor(sellable + 1e-6)));
                setAcknowledged(false);
              }}
              className="-mt-2 text-xs text-emerald-700 hover:underline dark:text-emerald-400"
            >
              Redeem all ({whole(sellable)} units)
            </button>
          )}

          {unitsNum > 0 && nav > 0 && (
            <dl className="grid gap-2 rounded-md bg-zinc-50 p-4 text-sm dark:bg-zinc-950">
              <Row label="Estimated Amount" value={bdt(estimatedAmount)} />
              <Row label="Estimated Gain/Loss" value={bdt(estimatedGain)} />
            </dl>
          )}

          {boBlocked && (
            <p className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
              {investor?.bo.message}
            </p>
          )}

          <Actions
            next="Next Step"
            nextDisabled={!investor || !holding || unitsNum <= 0 || unitsNum > sellable + 1e-6 || boBlocked}
            onNext={() => setStep(1)}
          />
        </Card>
      )}

      {/* ───── BO Withdrawal Form (BO holders in a BO fund only) ───── */}
      {step === 1 && needsBoStep && (
        <Card title="BO Units Withdrawal Form">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            The investor&apos;s units are held in a BO (demat) account, so they must be transferred to the
            fund&apos;s repurchase account before this sale can be executed. Download the form below; the
            investor signs it and sends it to their DP / brokerage house.
          </p>
          <dl className="grid gap-2 rounded-md bg-zinc-50 p-4 text-sm dark:bg-zinc-950">
            <Row label="Depository Participant" value={`${investor?.bo.dpName} (${investor?.bo.dpId})`} />
            <Row label="BO ID" value={investor?.bo.boId ?? ""} />
            <Row label="Fund" value={holding?.fundName ?? ""} />
            <Row label="Units to transfer" value={unitsNum.toLocaleString("en-IN")} />
            <Row label="Reason for transfer" value="Surrender of units" />
          </dl>
          <div className="text-center">
            <a
              href={previewFormHref}
              className="inline-flex items-center gap-2 rounded-md bg-emerald-700 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-800"
            >
              ↓ Download BO Units Withdrawal Form
            </a>
          </div>
          <label className="flex items-start gap-2 text-sm text-zinc-700 dark:text-zinc-300">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              className="mt-1"
            />
            <span>
              I have downloaded this form for the investor to sign and send to their DP / brokerage house.
              I understand the sell order will <strong>not be executed</strong> until the DP-40 report they
              return is uploaded.
            </span>
          </label>
          <Actions back={() => setStep(0)} next="Next Step" nextDisabled={!acknowledged} onNext={() => setStep(2)} />
        </Card>
      )}

      {/* ───── Authorisation (agent-only) ───── */}
      {step === authStep && (
        <Card title="Client's authorisation to sell">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Attach the client&apos;s written authorisation for this sale — the email they sent, or a
            screenshot of their message, saved as a PDF or image. You are selling on their behalf, so their
            authorisation has to be on file before the office will approve it.
          </p>
          <Field label="Client's authorisation to sell (PDF or image)">
            <FileInput file={instruction} onFile={setInstruction} />
          </Field>
          {instruction && instruction.size > MAX_BYTES && (
            <p className="text-sm font-medium text-red-700 dark:text-red-300">
              {mb(instruction.size)} is too large to send — the limit is {mb(MAX_BYTES)}. Re-save it smaller and
              attach again.
            </p>
          )}
          <Actions
            back={() => setStep(needsBoStep ? 1 : 0)}
            next="Next Step"
            nextDisabled={!instruction || instruction.size > MAX_BYTES}
            onNext={() => setStep(confirmStep)}
          />
        </Card>
      )}

      {/* ───── Confirm ───── */}
      {step === confirmStep && (
        <Card title="Confirm Redemption">
          <dl className="grid gap-2 rounded-md border border-zinc-200 p-4 text-sm dark:border-zinc-800">
            <Row label="Investor" value={`${investor?.investorCode} — ${investor?.name}`} />
            <Row label="Fund" value={`${holding?.fundName} (${fundCode})`} />
            <Row label="Units" value={unitsNum.toLocaleString("en-IN")} />
            <Row label="NAV" value={bdt(nav, 4)} />
            <Row label="Estimated Amount" value={bdt(estimatedAmount)} />
            <Row label="Estimated Gain/Loss" value={bdt(estimatedGain)} />
            <Row label="Client authorisation" value={instruction?.name ?? "—"} />
            <Row label="Raised by" value={`Sales agent ${agentCode}`} />
          </dl>
          {needsBoStep && (
            <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
              This order will be placed but <strong>not executed</strong> until the broker&apos;s DP-40 report is
              uploaded.
            </p>
          )}
          <Actions
            back={() => setStep(authStep)}
            next={busy ? "Submitting…" : "Confirm Sell Order"}
            nextDisabled={busy}
            onNext={submit}
            danger
          />
        </Card>
      )}
    </div>
  );
}

// ─────────────────── Open BO sells awaiting DP-40 ───────────────────

type OpenRow = {
  orderId: string;
  investorCode: string;
  investorName: string;
  fundCode: string;
  fundName: string;
  units: number;
  estAmount: number;
  createdAt: string;
  dpName: string;
  dpId: string;
  markedSoldAt: string | null;
  placedByAgent: boolean;
};

export function OpenBoSells({ rows }: { rows: OpenRow[] }) {
  return (
    <section className="space-y-3">
      <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">BO sells awaiting the DP-40 report</h2>
      <p className="text-xs text-zinc-500">
        These orders are placed but not executed. Upload the broker&apos;s DP-40 report here — or the investor
        can upload it from their portal — and the order moves to the office&apos;s approvals queue.
      </p>
      {rows.map((r) => (
        <OpenSellRow key={r.orderId} row={r} />
      ))}
    </section>
  );
}

function OpenSellRow({ row }: { row: OpenRow }) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState<"" | "upload" | "cancel">("");
  const busyRef = useRef(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function post(kind: "upload" | "cancel") {
    if (busyRef.current) return;
    if (kind === "cancel" && !window.confirm(`Cancel the ${row.fundCode} sell of ${Math.round(row.units).toLocaleString("en-IN")} units for ${row.investorCode}?`)) return;
    busyRef.current = true;
    setBusy(kind);
    setMsg(null);
    let res: Response;
    try {
      if (kind === "upload") {
        // Direct to storage with retries, then post the key — same reason as
        // every other agent upload: a broker's DP-40 scan is often a large PDF
        // and one blip should not lose it.
        const ref = await uploadKycDocument(file!);
        res = await fetch(`/api/agent/sell/${encodeURIComponent(row.orderId)}/dp40`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ documents: { dp40: ref } }),
        });
      } else {
        res = await fetch(`/api/agent/sell/${encodeURIComponent(row.orderId)}/cancel`, { method: "POST" });
      }
    } catch (e) {
      busyRef.current = false;
      setBusy("");
      setMsg({
        ok: false,
        text: `${e instanceof Error ? e.message : "The connection dropped"}. Nothing was changed — try again.`,
      });
      return;
    }
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; message?: string };
    busyRef.current = false;
    setBusy("");
    if (!res.ok || !data.ok) {
      setMsg({ ok: false, text: data.error ?? `Failed (HTTP ${res.status}).` });
      return;
    }
    setMsg({ ok: true, text: data.message ?? "Done." });
    router.refresh();
  }

  return (
    <div className="space-y-3 rounded-lg border border-zinc-200 bg-white p-4 text-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium text-zinc-900 dark:text-zinc-50">
          {row.investorCode} — {row.investorName} · {row.fundCode} · {Math.round(row.units).toLocaleString("en-IN")} units
        </p>
        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] text-amber-800 dark:bg-amber-950 dark:text-amber-200">
          Awaiting DP-40
        </span>
      </div>
      <p className="text-xs text-zinc-500">
        Placed {new Date(row.createdAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}
        {" · "}
        {row.placedByAgent ? "by you" : "by the investor"} · DP {row.dpName} ({row.dpId}) · est. BDT {bdt(row.estAmount)}
        {row.markedSoldAt ? " · already booked by accounts" : ""}
      </p>
      <div className="flex flex-wrap gap-4 text-xs">
        <a href={`/api/agent/sell/bo-form?orderId=${encodeURIComponent(row.orderId)}`} className="font-medium text-emerald-700 hover:underline dark:text-emerald-400">
          ↓ BO withdrawal form
        </a>
        <a
          href={`/agent/forms/sell-order?orderId=${encodeURIComponent(row.orderId)}`}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-emerald-700 hover:underline dark:text-emerald-400"
        >
          ↗ Sell order form
        </a>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[220px] flex-1">
          <span className="mb-1 block text-xs text-zinc-600 dark:text-zinc-400">DP-40 report (PDF or image)</span>
          <FileInput file={file} onFile={setFile} />
        </div>
        <button
          type="button"
          onClick={() => post("upload")}
          disabled={!file || busy !== "" || (file?.size ?? 0) > MAX_BYTES}
          className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-60"
        >
          {busy === "upload" ? "Uploading…" : "Upload DP-40"}
        </button>
        {row.placedByAgent && (
          <button
            type="button"
            onClick={() => post("cancel")}
            disabled={busy !== ""}
            className="rounded-md border border-red-300 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-60 dark:border-red-900 dark:text-red-300"
          >
            {busy === "cancel" ? "Cancelling…" : "Cancel order"}
          </button>
        )}
      </div>
      {msg && (
        <p className={msg.ok ? "text-xs text-emerald-700 dark:text-emerald-400" : "text-xs text-red-700 dark:text-red-300"}>
          {msg.text}
        </p>
      )}
    </div>
  );
}

// ─────────────────── Pieces (same look as Buy Fund) ───────────────────

function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="flex flex-wrap gap-2 text-[11px]">
      {steps.map((s, i) => (
        <li
          key={s}
          className={`rounded-full px-3 py-1 ${
            i === current
              ? "bg-emerald-700 font-medium text-white"
              : i < current
                ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
                : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
          }`}
        >
          {i + 1}. {s}
        </li>
      ))}
    </ol>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-4 rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">{title}</h2>
      {children}
    </div>
  );
}

function Field({
  label,
  accent,
  htmlFor,
  children,
}: {
  label: string;
  accent?: boolean;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  const caption = (
    <span
      className={`mb-1 block ${
        accent ? "font-medium text-emerald-700 dark:text-emerald-400" : "text-zinc-600 dark:text-zinc-400"
      }`}
    >
      {label}
    </span>
  );
  if (htmlFor) {
    return (
      <div className="block text-sm">
        <label htmlFor={htmlFor}>{caption}</label>
        {children}
      </div>
    );
  }
  return (
    <label className="block text-sm">
      {caption}
      {children}
    </label>
  );
}

function FileInput({ file, onFile }: { file: File | null; onFile: (f: File | null) => void }) {
  return (
    <div>
      <input
        type="file"
        accept="image/jpeg,image/png,image/webp,application/pdf"
        onChange={(e) => onFile(e.target.files?.[0] ?? null)}
        className="w-full text-xs text-zinc-600 file:mr-3 file:rounded file:border-0 file:bg-emerald-100 file:px-3 file:py-1.5 file:text-emerald-800 dark:text-zinc-400 dark:file:bg-emerald-950 dark:file:text-emerald-200"
      />
      {file && (
        <p className="mt-1 text-[11px] text-zinc-500">
          {file.name} · {mb(file.size)}
        </p>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-zinc-500">{label}</dt>
      <dd className="text-right font-medium text-zinc-900 dark:text-zinc-100">{value}</dd>
    </div>
  );
}

function Actions({
  back,
  next,
  nextDisabled,
  onNext,
  danger,
}: {
  back?: () => void;
  next: string;
  nextDisabled?: boolean;
  onNext: () => void;
  danger?: boolean;
}) {
  return (
    <div className="flex justify-between pt-2">
      {back ? (
        <button
          type="button"
          onClick={back}
          className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 dark:border-zinc-700 dark:text-zinc-300"
        >
          Back
        </button>
      ) : (
        <span />
      )}
      <button
        type="button"
        onClick={onNext}
        disabled={nextDisabled}
        className={`rounded-md px-5 py-2 text-sm font-medium text-white disabled:opacity-60 ${
          danger ? "bg-red-600 hover:bg-red-700" : "bg-emerald-700 hover:bg-emerald-800"
        }`}
      >
        {next}
      </button>
    </div>
  );
}
