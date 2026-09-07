"use client";

// The agent-side Buy Fund wizard. Step structure, field order, labels and
// wording are taken from the investor-facing flow at
// apps/portal/src/app/(portal)/transactions/buy/page.tsx so a client is walked
// through the same purchase whoever raises it. Two things differ:
//
//   • an investor picker on step 0, since the agent is acting for someone else;
//   • an Instruction step, where the agent attaches the client's written
//     agreement to purchase. That is the authority for acting on their behalf,
//     so it is mandatory here and has no equivalent in the investor flow.
//
// Unit price and No of units stay read-only and derived from the live NAV,
// exactly as in the portal.

import { useMemo, useState } from "react";
import Link from "next/link";
import type { PurchaseFundOption, PurchaseInvestorOption } from "@/lib/agent-purchase";
import { bankAccountsForFund } from "@/lib/fund-bank-accounts";

const STEPS = ["Information", "Payment", "Instruction", "Confirm", "Success"];

// The whole form posts as one multipart body and a Vercel function caps the
// request at 4.5 MB. Check it here and say so, rather than letting the platform
// kill the upload and leave the agent staring at a spinner.
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;

function bdt(n: number, decimals = 2): string {
  return n.toLocaleString("en-IN", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function mb(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${Math.round(bytes / 1024)} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

type Done = {
  orderId: string;
  fundCode: string;
  fundName: string;
  amount: number;
  nav: number;
  estUnits: number;
  investorCode: string;
  message: string;
};

export function PurchaseClient({
  investors,
  funds,
  agentCode,
}: {
  investors: PurchaseInvestorOption[];
  funds: PurchaseFundOption[];
  agentCode: string;
}) {
  const [step, setStep] = useState(0);
  const [investorCode, setInvestorCode] = useState(investors[0]?.investorCode ?? "");
  const [fundCode, setFundCode] = useState("");
  const [amountRaw, setAmountRaw] = useState("");
  const [paymentSlip, setPaymentSlip] = useState<File | null>(null);
  const [instruction, setInstruction] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);

  const investor = investors.find((i) => i.investorCode === investorCode) ?? null;
  const fund = funds.find((f) => f.code === fundCode) ?? null;
  const nav = fund?.currentNav ?? 0;
  const amountNum = parseFloat(amountRaw) || 0;

  // Same arithmetic as the portal: units are floored to 4 dp and the amount
  // actually ordered is the units × NAV, so the figure on the form is one the
  // fund can actually allot.
  const estimatedUnits = nav > 0 ? Math.floor((amountNum / nav) * 10000) / 10000 : 0;
  const actualAmount = estimatedUnits * nav;

  const banks = bankAccountsForFund(fundCode);
  const totalBytes = (paymentSlip?.size ?? 0) + (instruction?.size ?? 0);

  const formPreviewHref = useMemo(() => {
    if (!fund || !investor) return "";
    const q = new URLSearchParams({
      investorCode: investor.investorCode,
      fundCode: fund.code,
      fundName: fund.name,
      amount: String(actualAmount),
      units: String(Math.round(estimatedUnits)),
      nav: nav.toFixed(4),
      payment: "Bank Transfer",
    });
    return `/agent/forms/purchase?${q.toString()}`;
  }, [fund, investor, actualAmount, estimatedUnits, nav]);

  async function submit() {
    if (!investor || !fund) return;
    setError(null);

    if (totalBytes > MAX_TOTAL_BYTES) {
      setError(
        `The two attachments come to ${mb(totalBytes)}. One order can carry at most ${mb(MAX_TOTAL_BYTES)} in total. Re-save them as JPG or a smaller PDF and attach them again.`,
      );
      return;
    }

    setBusy(true);
    const fd = new FormData();
    fd.set("investorCode", investor.investorCode);
    fd.set("fundCode", fund.code);
    fd.set("amount", String(actualAmount));
    fd.set("paymentSlip", paymentSlip!);
    fd.set("instruction", instruction!);

    let res: Response;
    try {
      res = await fetch("/api/agent/purchase", { method: "POST", body: fd });
    } catch (e) {
      // Never leave the button spinning: a killed upload rejects here, and an
      // unguarded await would strand the agent with no message at all.
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
      /* not JSON — handled below */
    }
    setBusy(false);

    if (!res.ok || !data?.ok) {
      setError(
        data?.error ??
          `The server answered HTTP ${res.status} with no reason given. Nothing was saved.`,
      );
      return;
    }
    setDone(data as Done);
    setStep(4);
  }

  // ───────────────────────── Success ─────────────────────────
  if (done) {
    const receiptHref = `/agent/forms/order-confirmation?${new URLSearchParams({
      investorCode: done.investorCode,
      fundCode: done.fundCode,
      fundName: done.fundName,
      amount: String(done.amount),
      units: String(Math.round(done.estUnits)),
      nav: done.nav.toFixed(4),
      orderId: done.orderId,
    }).toString()}`;

    return (
      <div className="rounded-lg border border-emerald-300 bg-white p-6 dark:border-emerald-800 dark:bg-zinc-900">
        <h2 className="text-xl font-semibold text-emerald-800 dark:text-emerald-300">
          Order submitted ✓
        </h2>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">{done.message}</p>

        <dl className="mt-4 grid gap-2 rounded-md border border-zinc-200 p-4 text-sm dark:border-zinc-800">
          <Row label="Investor" value={`${done.investorCode} — ${investor?.name ?? ""}`} />
          <Row label="Fund" value={`${done.fundName} (${done.fundCode})`} />
          <Row label="Amount" value={`BDT ${bdt(done.amount)}`} />
          <Row label="NAV" value={bdt(done.nav, 4)} />
          <Row label="Est. units" value={Math.round(done.estUnits).toLocaleString("en-IN")} />
          <Row label="Status" value="Pending approval" />
        </dl>

        <p className="mt-4 text-xs text-zinc-500 dark:text-zinc-400">
          The office sees this on the approvals queue with your agent code against it. The investor
          is emailed and messaged on WhatsApp automatically once it is approved — nothing is sent
          before that.
        </p>

        <div className="mt-5 flex flex-wrap gap-3">
          <a
            href={receiptHref}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800"
          >
            Download Order Confirmation
          </a>
          <button
            onClick={() => {
              setDone(null);
              setStep(0);
              setFundCode("");
              setAmountRaw("");
              setPaymentSlip(null);
              setInstruction(null);
              setError(null);
            }}
            className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 dark:border-zinc-700 dark:text-zinc-300"
          >
            Place Another Order
          </button>
          <Link
            href="/agent"
            className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 dark:border-zinc-700 dark:text-zinc-300"
          >
            Back to dashboard
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <Stepper current={step} />

      {error && (
        <p
          role="alert"
          className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
        >
          {error}
        </p>
      )}

      {/* ───── Step 0: Information ───── */}
      {step === 0 && (
        <Card title="Investment's Information">
          <Field label="Investor">
            <select
              value={investorCode}
              onChange={(e) => setInvestorCode(e.target.value)}
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:[color-scheme:dark]"
            >
              {investors.map((i) => (
                <option key={i.investorCode} value={i.investorCode}>
                  {i.investorCode} — {i.name}
                </option>
              ))}
            </select>
            {investor && (
              <p className="mt-1 text-[11px] text-zinc-500">
                {investor.email ?? "no email on file"}
                {investor.via === "onboarded" ? " · onboarded by you" : " · your client"}
              </p>
            )}
          </Field>

          <Field label="Fund">
            <select
              value={fundCode}
              onChange={(e) => setFundCode(e.target.value)}
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:[color-scheme:dark]"
            >
              <option value="">Please select a fund</option>
              {funds.map((f) => (
                <option key={f.code} value={f.code}>
                  {f.code} - {f.name}
                </option>
              ))}
            </select>
            {fund && fund.currentNav === null && (
              <p className="mt-1 text-[11px] text-red-600 dark:text-red-400">
                No NAV is published for this fund yet, so an order cannot be priced.
              </p>
            )}
          </Field>

          <Field label="Amount" accent>
            <input
              type="number"
              min="1"
              value={amountRaw}
              onChange={(e) => setAmountRaw(e.target.value)}
              placeholder="Enter investment amount"
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 font-mono text-sm dark:border-zinc-700 dark:bg-zinc-950"
            />
          </Field>

          <Field label="Unit price *">
            <input
              readOnly
              value={nav > 0 ? bdt(nav, 4) : ""}
              className="w-full rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 font-mono text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400"
            />
          </Field>

          <Field label="No of units *">
            <input
              readOnly
              value={estimatedUnits > 0 ? Math.round(estimatedUnits).toLocaleString("en-IN") : ""}
              className="w-full rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 font-mono text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400"
            />
          </Field>

          <Actions
            next="Next Step"
            nextDisabled={!investor || !fund || nav <= 0 || amountNum <= 0}
            onNext={() => setStep(1)}
          />
        </Card>
      )}

      {/* ───── Step 1: Payment ───── */}
      {step === 1 && (
        <Card title="Payment">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            The investor deposits the amount to the following bank account of{" "}
            {fund?.name ?? "the fund"}.
          </p>

          <div className="grid gap-3 sm:grid-cols-2">
            {banks.map((b, idx) => (
              <div
                key={idx}
                className="rounded-md border border-zinc-200 p-4 text-xs dark:border-zinc-800"
              >
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
                  {b.bankName}
                </p>
                <Line label="Account Name" value={b.accountName} />
                <Line label="Account No" value={b.accountNo} />
                <Line label="Bank Name" value={b.bankName} />
                <Line label="Branch" value={b.branchName} />
                <Line label="Routing No" value={b.routingNo} />
              </div>
            ))}
          </div>

          <Field label="Payment confirmation / acknowledgement receipt / cheque deposit slip">
            <FileInput file={paymentSlip} onFile={setPaymentSlip} />
          </Field>

          <Actions
            back={() => setStep(0)}
            next="Next Step"
            nextDisabled={!paymentSlip}
            onNext={() => setStep(2)}
          />
        </Card>
      )}

      {/* ───── Step 2: Instruction (agent-only) ───── */}
      {step === 2 && (
        <Card title="Client's purchase instruction">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Attach the client&apos;s written agreement to this purchase — the email they sent, or a
            screenshot of their message, saved as a PDF or image. You are placing this order on
            their behalf, so their instruction has to be on file before the office will approve it.
          </p>

          <Field label="Agreed purchase instruction (PDF or image)">
            <FileInput file={instruction} onFile={setInstruction} />
          </Field>

          {totalBytes > 0 && (
            <p
              className={
                totalBytes > MAX_TOTAL_BYTES
                  ? "text-sm font-medium text-red-700 dark:text-red-300"
                  : "text-sm text-zinc-600 dark:text-zinc-400"
              }
            >
              Attachments: {mb(totalBytes)} of {mb(MAX_TOTAL_BYTES)}
              {totalBytes > MAX_TOTAL_BYTES
                ? " — too large to send. Re-save them smaller and attach again."
                : null}
            </p>
          )}

          <Actions
            back={() => setStep(1)}
            next="Next Step"
            nextDisabled={!instruction || totalBytes > MAX_TOTAL_BYTES}
            onNext={() => setStep(3)}
          />
        </Card>
      )}

      {/* ───── Step 3: Confirm ───── */}
      {step === 3 && (
        <Card title="Confirmation">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Please confirm to submit the order for approval.
          </p>

          <div className="text-center">
            <a
              href={formPreviewHref}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-md border-2 border-[#2DAAB8] px-5 py-2.5 text-sm font-medium text-[#2DAAB8] transition-colors hover:bg-[#2DAAB8] hover:text-white"
            >
              Purchase Form Preview ↗
            </a>
          </div>

          <dl className="grid gap-2 rounded-md border border-zinc-200 p-4 text-sm dark:border-zinc-800">
            <Row label="Investor" value={`${investor?.investorCode} — ${investor?.name}`} />
            <Row label="Fund" value={`${fund?.name} (${fund?.code})`} />
            <Row label="Amount" value={bdt(actualAmount)} />
            <Row label="NAV" value={bdt(nav, 4)} />
            <Row
              label="Estimated Units"
              value={Math.round(estimatedUnits).toLocaleString("en-IN")}
            />
            <Row label="Payment" value="Bank Transfer" />
            <Row label="Deposit slip" value={paymentSlip?.name ?? "—"} />
            <Row label="Client instruction" value={instruction?.name ?? "—"} />
            <Row label="Raised by" value={`Sales agent ${agentCode}`} />
          </dl>

          <Actions
            back={() => setStep(2)}
            next={busy ? "Submitting…" : "Confirm Order"}
            nextDisabled={busy}
            onNext={submit}
          />
        </Card>
      )}
    </div>
  );
}

function Stepper({ current }: { current: number }) {
  return (
    <ol className="flex flex-wrap gap-2 text-[11px]">
      {STEPS.map((s, i) => (
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
  children,
}: {
  label: string;
  accent?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block text-sm">
      <span
        className={`mb-1 block ${
          accent ? "font-medium text-emerald-700 dark:text-emerald-400" : "text-zinc-600 dark:text-zinc-400"
        }`}
      >
        {label}
      </span>
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

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2 py-0.5">
      <span className="text-zinc-500">{label}:</span>
      <span className="font-medium text-zinc-800 dark:text-zinc-200">{value}</span>
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
}: {
  back?: () => void;
  next: string;
  nextDisabled?: boolean;
  onNext: () => void;
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
        className="rounded-md bg-emerald-700 px-5 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-60"
      >
        {next}
      </button>
    </div>
  );
}
