"use client";

// The agent-side SIP form. Same journey the investor gets on
// portal.ekushwml.com/sip — fund, amount, tenure, debit day, bank, then Terms
// and a DDI preview before anything is written — with two differences:
//
//  1. An investor picker at the top, because the agent is acting for someone
//     else. Everything below it re-derives from the selected investor.
//  2. The debit day is ANY day 1–31, not the portal's three pills. Days 29–31
//     do not exist in every month, so the form states what will actually happen
//     before the agent commits, and clause 2 of the Terms is worded to match
//     (the portal's copy names only the 5th/15th/26th, which would be a false
//     statement on a form the investor signs).

import { useMemo, useState } from "react";
import Link from "next/link";
import type { SipFundOption, SipInvestorOption } from "@/lib/agent-sip";
import {
  addYearsKeepingDay,
  clampDayToMonth,
  debitDayLabel,
  nextDebitDate,
  ordinal,
  SIP_MIN_AMOUNT,
  TENURE_MAX,
  TENURE_MIN,
} from "@/lib/sip-dates";

const AMOUNT_QUICK_PICKS = [1000, 2500, 5000, 10000, 25000];
const bdt = (n: number) => "BDT " + Math.round(n).toLocaleString("en-IN");
const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const longDate = (d: Date) =>
  d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

export function SipClient({
  investors,
  funds,
  agentCode,
}: {
  investors: SipInvestorOption[];
  funds: SipFundOption[];
  agentCode: string;
}) {
  const [investorCode, setInvestorCode] = useState(investors[0]?.investorCode ?? "");
  const [fundCode, setFundCode] = useState(funds[0]?.code ?? "");
  const [amount, setAmount] = useState(5000);
  const [tenure, setTenure] = useState(5);
  const [debitDay, setDebitDay] = useState(5);
  const [bankAccountId, setBankAccountId] = useState<string | null>(null);
  const [showTerms, setShowTerms] = useState(false);
  const [showDdi, setShowDdi] = useState(false);
  const [showBankForm, setShowBankForm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ sipPlanId: string; startDate: string; endDate: string } | null>(null);

  const investor = investors.find((i) => i.investorCode === investorCode) ?? null;
  const fund = funds.find((f) => f.code === fundCode) ?? null;
  const activeBanks = investor?.banks.filter((b) => b.status === "ACTIVE") ?? [];
  const pendingBank = investor?.banks.find((b) => b.status === "PENDING_APPROVAL") ?? null;
  const minAmount = fund && fund.minSipAmount > 0 ? fund.minSipAmount : SIP_MIN_AMOUNT;

  // Whichever bank is chosen, default to the primary the moment the investor
  // changes — carrying a previous investor's account id across would be caught
  // by the API's ownership check, but it should never get that far.
  const effectiveBankId = useMemo(() => {
    if (bankAccountId && activeBanks.some((b) => b.id === bankAccountId)) return bankAccountId;
    return activeBanks.find((b) => b.isPrimary)?.id ?? activeBanks[0]?.id ?? null;
  }, [bankAccountId, activeBanks]);

  const start = useMemo(() => nextDebitDate(new Date(), debitDay), [debitDay]);
  const end = useMemo(() => addYearsKeepingDay(start, tenure, debitDay), [start, tenure, debitDay]);
  const firstClamped = clampDayToMonth(start.getFullYear(), start.getMonth(), debitDay);
  const dayVaries = debitDay > 28;

  const duplicate = investor?.existingSips.find((s) => s.fundCode === fundCode) ?? null;

  function validate(): string | null {
    if (!investor) return "Select an investor.";
    if (!fund) return "Select a fund.";
    if (!Number.isFinite(amount) || amount < minAmount)
      return `Minimum monthly investment for ${fund.code} is ${bdt(minAmount)}.`;
    if (tenure < TENURE_MIN || tenure > TENURE_MAX)
      return `Tenure must be between ${TENURE_MIN} and ${TENURE_MAX} years.`;
    if (debitDay < 1 || debitDay > 31) return "Debit day must be between 1 and 31.";
    if (!effectiveBankId)
      return "This investor has no approved bank account. Add one below — a SIP cannot be debited without it.";
    return null;
  }

  async function submit() {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/agent/sip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        investorCode,
        fundCode,
        amount,
        tenure,
        debitDay,
        bankAccountId: effectiveBankId,
      }),
    });
    const data = await res.json().catch(() => ({ error: "Unexpected response." }));
    setBusy(false);
    setShowDdi(false);
    if (!res.ok || !data.ok) {
      setError(data.error ?? "Could not submit the SIP.");
      return;
    }
    setDone({ sipPlanId: data.sipPlanId, startDate: data.startDate, endDate: data.endDate });
  }

  if (done) {
    return (
      <div className="rounded-lg border border-emerald-300 bg-white p-6 dark:border-emerald-800 dark:bg-zinc-900">
        <h2 className="text-xl font-semibold text-emerald-800 dark:text-emerald-300">SIP submitted ✓</h2>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          The instruction for <strong>{investor?.name}</strong> ({investorCode}) is now{" "}
          <strong>awaiting approval</strong> by the office. It appears on the portal&apos;s approvals
          queue tagged with your agent code.
        </p>
        <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
          <Row label="Fund" value={fund?.name ?? fundCode} />
          <Row label="Monthly amount" value={bdt(amount)} />
          <Row label="Debit day" value={debitDayLabel(debitDay)} />
          <Row label="First debit" value={longDate(new Date(done.startDate + "T00:00:00"))} />
          <Row label="Mandate ends" value={longDate(new Date(done.endDate + "T00:00:00"))} />
        </dl>
        <div className="mt-5 flex flex-wrap gap-3">
          <a
            href={`/agent/forms/ddi?sipPlanId=${encodeURIComponent(done.sipPlanId)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800"
          >
            Print the DDI form
          </a>
          <a
            href={`/api/agent/sip/${encodeURIComponent(done.sipPlanId)}/bank-excel`}
            className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            Download bank auto-debit Excel
          </a>
          <Link
            href="/agent/sip"
            className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            Create another
          </Link>
        </div>
        <p className="mt-4 text-xs text-zinc-500">
          The investor must sign the DDI form. The Excel is the file the collection bank needs to
          register the mandate — send it only once the office has approved the plan.
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[1.6fr_1fr]">
      <div className="space-y-5">
        {/* Investor */}
        <Card title="Investor" hint="Only investors you sourced whose account is fully open.">
          <label className="block text-sm">
            <span className="mb-1 block text-zinc-600 dark:text-zinc-400">Investor</span>
            <select
              value={investorCode}
              onChange={(e) => {
                setInvestorCode(e.target.value);
                setBankAccountId(null);
                setShowBankForm(false);
              }}
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 dark:border-zinc-700 dark:bg-zinc-950"
            >
              {investors.map((i) => (
                <option key={i.investorCode} value={i.investorCode}>
                  {i.investorCode} — {i.name}
                </option>
              ))}
            </select>
          </label>
          {investor?.email && (
            <p className="mt-2 text-xs text-zinc-500">{investor.email}</p>
          )}
          {investor && investor.existingSips.length > 0 && (
            <p className="mt-2 text-xs text-zinc-500">
              Existing SIPs:{" "}
              {investor.existingSips
                .map((s) => `${s.fundCode} ${bdt(s.amount)} (${s.status.toLowerCase().replace("_", " ")})`)
                .join(" · ")}
            </p>
          )}
        </Card>

        {/* Fund + amount + tenure */}
        <Card title="Instruction">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="mb-1 block text-zinc-600 dark:text-zinc-400">Fund</span>
              <select
                value={fundCode}
                onChange={(e) => setFundCode(e.target.value)}
                className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 dark:border-zinc-700 dark:bg-zinc-950"
              >
                {funds.map((f) => (
                  <option key={f.code} value={f.code}>
                    {f.code} — {f.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="block text-sm">
              <span className="mb-1 block text-zinc-600 dark:text-zinc-400">
                Monthly amount (min {bdt(minAmount)})
              </span>
              <input
                type="number"
                min={minAmount}
                step={500}
                value={amount}
                onChange={(e) => setAmount(Number(e.target.value))}
                className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 tabular-nums dark:border-zinc-700 dark:bg-zinc-950"
              />
            </label>
          </div>

          <div className="mt-2 flex flex-wrap gap-2">
            {AMOUNT_QUICK_PICKS.map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setAmount(v)}
                className={`rounded-full border px-3 py-1 text-xs ${
                  amount === v
                    ? "border-emerald-600 bg-emerald-600 text-white"
                    : "border-zinc-300 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                }`}
              >
                {v.toLocaleString("en-IN")}
              </button>
            ))}
          </div>

          <label className="mt-4 block text-sm">
            <span className="mb-1 block text-zinc-600 dark:text-zinc-400">
              Tenure — {tenure} year{tenure > 1 ? "s" : ""}
            </span>
            <input
              type="range"
              min={TENURE_MIN}
              max={TENURE_MAX}
              value={tenure}
              onChange={(e) => setTenure(Number(e.target.value))}
              className="w-full accent-emerald-600"
            />
          </label>
        </Card>

        {/* Debit day — the part that differs from the portal */}
        <Card
          title="Debit day"
          hint="Any day of the month. The investor's bank debits on this day; if it falls on a weekend or holiday the debit moves to the next working day."
        >
          <div className="flex flex-wrap items-center gap-3">
            <input
              type="number"
              min={1}
              max={31}
              value={debitDay}
              onChange={(e) => setDebitDay(Math.min(31, Math.max(1, Number(e.target.value) || 1)))}
              className="w-24 rounded-md border border-zinc-300 bg-white px-3 py-2 text-center tabular-nums dark:border-zinc-700 dark:bg-zinc-950"
            />
            <span className="text-sm text-zinc-600 dark:text-zinc-400">
              {ordinal(debitDay)} of each month
            </span>
            <div className="flex flex-wrap gap-1">
              {[5, 15, 26].map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setDebitDay(d)}
                  className={`rounded-full border px-2.5 py-1 text-xs ${
                    debitDay === d
                      ? "border-emerald-600 bg-emerald-600 text-white"
                      : "border-zinc-300 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                  }`}
                >
                  {ordinal(d)}
                </button>
              ))}
            </div>
          </div>

          {dayVaries && (
            <p className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-2.5 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
              Day {debitDay} does not exist in every month. In shorter months the debit falls on the
              last day instead — February {start.getFullYear()} would be the{" "}
              {ordinal(clampDayToMonth(start.getFullYear(), 1, debitDay))}. This wording is printed on
              the DDI form the investor signs.
            </p>
          )}

          <dl className="mt-3 grid gap-1 text-xs text-zinc-600 dark:text-zinc-400">
            <div className="flex justify-between">
              <dt>First debit</dt>
              <dd className="tabular-nums">
                {longDate(start)}
                {firstClamped !== debitDay ? ` (day ${firstClamped} this month)` : ""}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt>Mandate ends</dt>
              <dd className="tabular-nums">{longDate(end)}</dd>
            </div>
          </dl>
        </Card>

        {/* Bank */}
        <Card
          title="Debit account"
          hint="The bank account the installment is pulled from. It must be approved before the mandate can go to the bank."
        >
          {activeBanks.length > 0 ? (
            <div className="space-y-2">
              {activeBanks.map((b) => (
                <label
                  key={b.id}
                  className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm ${
                    effectiveBankId === b.id
                      ? "border-emerald-500 bg-emerald-50 dark:border-emerald-700 dark:bg-emerald-950/30"
                      : "border-zinc-200 dark:border-zinc-800"
                  }`}
                >
                  <input
                    type="radio"
                    name="bank"
                    checked={effectiveBankId === b.id}
                    onChange={() => setBankAccountId(b.id)}
                    className="mt-1 accent-emerald-600"
                  />
                  <span>
                    <span className="font-medium">{b.bankName}</span>
                    {b.isPrimary && (
                      <span className="ml-2 rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] uppercase text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                        primary
                      </span>
                    )}
                    <span className="block text-xs text-zinc-500">
                      A/C {b.accountNumber}
                      {b.branchName ? ` · ${b.branchName}` : ""}
                      {b.routingNumber ? ` · routing ${b.routingNumber}` : ""}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          ) : (
            <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
              This investor has no approved bank account. A SIP cannot be debited without one — add
              it below and the office will verify it against the NID before approving.
            </p>
          )}

          {pendingBank && (
            <p className="mt-2 text-xs text-zinc-500">
              A bank account ({pendingBank.bankName} · {pendingBank.accountNumber}) is already
              awaiting approval, so another cannot be added yet.
            </p>
          )}

          {!pendingBank && (activeBanks.length === 0 || showBankForm) ? (
            <BankForm
              investorCode={investorCode}
              onDone={() => window.location.reload()}
              onCancel={activeBanks.length > 0 ? () => setShowBankForm(false) : undefined}
            />
          ) : (
            !pendingBank &&
            activeBanks.length < 2 && (
              <button
                type="button"
                onClick={() => setShowBankForm(true)}
                className="mt-3 text-xs font-medium text-emerald-700 underline dark:text-emerald-400"
              >
                Add another bank account
              </button>
            )
          )}
        </Card>

        {duplicate && (
          <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
            This investor already has a {duplicate.status.toLowerCase().replace("_", " ")} SIP into{" "}
            {duplicate.fundCode} of {bdt(duplicate.amount)} on the {ordinal(duplicate.debitDay)}.
            Creating another will run both mandates — check this is intended.
          </p>
        )}

        {error && (
          <p className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
            {error}
          </p>
        )}

        <button
          type="button"
          onClick={() => {
            const v = validate();
            if (v) { setError(v); return; }
            setError(null);
            setShowTerms(true);
          }}
          className="rounded-md bg-emerald-700 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-800"
        >
          Review and submit
        </button>
      </div>

      {/* Summary rail */}
      <aside className="h-fit rounded-lg border border-zinc-200 bg-white p-5 text-sm dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Summary</h2>
        <dl className="mt-3 space-y-2">
          <Row label="Investor" value={investor ? `${investor.investorCode} — ${investor.name}` : "—"} />
          <Row label="Fund" value={fund?.name ?? "—"} />
          <Row label="Monthly" value={bdt(amount)} />
          <Row label="Tenure" value={`${tenure} year${tenure > 1 ? "s" : ""}`} />
          <Row label="Debit day" value={ordinal(debitDay)} />
          <Row label="First debit" value={longDate(start)} />
          <Row label="Ends" value={longDate(end)} />
          <Row label="Total invested" value={bdt(amount * 12 * tenure)} />
        </dl>
        <p className="mt-4 text-xs text-zinc-500">
          Raised by agent {agentCode}. The office approves it on the portal before the mandate is
          sent to the bank.
        </p>
      </aside>

      {showTerms && (
        <TermsModal
          debitDay={debitDay}
          onCancel={() => setShowTerms(false)}
          onAccept={() => {
            setShowTerms(false);
            setShowDdi(true);
          }}
        />
      )}

      {showDdi && investor && fund && (
        <ConfirmModal
          busy={busy}
          previewHref={`/agent/forms/ddi?investorCode=${encodeURIComponent(investorCode)}&fundCode=${encodeURIComponent(fundCode)}&amount=${encodeURIComponent(String(amount))}&debitDay=${encodeURIComponent(String(debitDay))}&tenure=${encodeURIComponent(String(tenure))}`}
          rows={[
            ["Investor", `${investor.investorCode} — ${investor.name}`],
            ["Fund", fund.name],
            ["Monthly amount", bdt(amount)],
            ["Debit day", debitDayLabel(debitDay)],
            ["First debit", longDate(start)],
            ["Tenure", `${tenure} year${tenure > 1 ? "s" : ""}`],
          ]}
          onCancel={() => setShowDdi(false)}
          onConfirm={submit}
        />
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

function Card({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">{title}</h2>
      {hint && <p className="mt-0.5 mb-3 text-xs text-zinc-500">{hint}</p>}
      <div className={hint ? "" : "mt-3"}>{children}</div>
    </section>
  );
}

/** Inline add-bank, mirroring the portal's own on /sip. The NID scan is
 *  mandatory and the row is written PENDING_APPROVAL — the office matches the
 *  name on the NID to the account holder before it can be used. */
function BankForm({
  investorCode,
  onDone,
  onCancel,
}: {
  investorCode: string;
  onDone: () => void;
  onCancel?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const fd = new FormData(e.currentTarget);
    fd.set("investorCode", investorCode);
    const res = await fetch("/api/agent/sip/bank", { method: "POST", body: fd });
    const data = await res.json().catch(() => ({ error: "Unexpected response." }));
    setBusy(false);
    if (!res.ok || !data.ok) {
      setErr(data.error ?? "Could not add the bank account.");
      return;
    }
    onDone();
  }

  return (
    <form onSubmit={submit} className="mt-3 space-y-3 rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
      <p className="text-xs text-zinc-500">
        The name on the NID must match the bank account name, otherwise the request will not be
        honoured.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field name="bankName" label="Bank name" required />
        <Field name="accountNumber" label="Account number" required />
        <Field name="branchName" label="Branch" />
        <Field name="routingNumber" label="Routing number" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <FileField name="nidImage" label="Investor's NID (required)" required />
        <FileField name="chequeLeaf" label="Cheque leaf (optional)" />
      </div>
      {err && <p className="text-xs text-red-700 dark:text-red-400">{err}</p>}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy}
          className="rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
        >
          {busy ? "Submitting…" : "Add bank account"}
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs dark:border-zinc-700"
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

function Field({ name, label, required }: { name: string; label: string; required?: boolean }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-xs text-zinc-600 dark:text-zinc-400">{label}</span>
      <input
        name={name}
        required={required}
        className="w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
      />
    </label>
  );
}

function FileField({ name, label, required }: { name: string; label: string; required?: boolean }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-xs text-zinc-600 dark:text-zinc-400">{label}</span>
      <input
        name={name}
        type="file"
        required={required}
        accept="image/jpeg,image/png,image/webp,application/pdf"
        className="w-full text-xs text-zinc-600 file:mr-3 file:rounded file:border-0 file:bg-emerald-100 file:px-3 file:py-1.5 file:text-emerald-800 dark:text-zinc-400 dark:file:bg-emerald-950 dark:file:text-emerald-200"
      />
    </label>
  );
}

function Modal({ title, subtitle, children, footer }: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  footer: React.ReactNode;
}) {
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/50" />
      <div className="fixed inset-4 z-50 mx-auto flex max-w-3xl flex-col overflow-hidden rounded-lg bg-white shadow-lg dark:bg-zinc-900 md:inset-y-12">
        <div className="bg-emerald-800 px-6 py-4">
          <h2 className="text-base font-bold text-white">{title}</h2>
          {subtitle && <p className="text-xs text-white/70">{subtitle}</p>}
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>
        <div className="flex justify-end gap-3 border-t border-zinc-200 px-6 py-4 dark:border-zinc-800">
          {footer}
        </div>
      </div>
    </>
  );
}

/**
 * The BEFTN terms the investor is agreeing to, carried over verbatim from the
 * portal's /sip page — except clause 2, which on the portal names only the
 * 5th, 15th and 26th. An agent may set any day, so the portal's wording would
 * be a false statement on a form the investor signs; it is restated here to
 * describe the day actually chosen, including the short-month fallback.
 */
function TermsModal({
  debitDay,
  onCancel,
  onAccept,
}: {
  debitDay: number;
  onCancel: () => void;
  onAccept: () => void;
}) {
  return (
    <Modal
      title="Terms and Conditions"
      footer={
        <>
          <button onClick={onCancel} className="rounded-md bg-red-500 px-4 py-2 text-sm font-medium text-white hover:bg-red-600">
            Cancel
          </button>
          <button onClick={onAccept} className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800">
            OK
          </button>
        </>
      }
    >
      <div className="space-y-4 text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
        <p>
          Transactions under this authorization will be subject to the BEFTN operating rules of
          Bangladesh Bank. All the BEFTN guidelines from Bangladesh Bank will be imposed on executing
          the above instruction, as applicable from time to time. Ekush Wealth Management Limited
          contains all the rights to change/modify/amend the terms and conditions. The guidelines of
          Bangladesh Bank regarding BEFTN shall govern the following terms and conditions:
        </p>
        <ol className="list-decimal space-y-3 pl-5">
          <li>BEFTN Debit facility for installment payment can be availed after the SIP is accepted and is in force. Payments other than Installment or arrears of installment (due to the previous months) should be paid via/cheque/bank draft/pay order/online transfer;</li>
          <li>
            Installment amount will be debited on the {debitDayLabel(debitDay)}. If the day is a
            weekend/ holiday, installment amount will be debited on the next working day.
          </li>
          <li>This authorization form must reach Ekush Wealth Management Limited at least 15 (fifteen) working days before the date on which it is to be activated. If the payment instruction date falls on a weekend day or a public holiday, the same may be effective on the next working day.</li>
          <li>This instruction shall stay fully in force and result till otherwise suggested in writing by the account holder and such endorsement should be communicated to and received by a minimum of 5 (five) working days before the next installment payment is due. Any such amendment/cancellation will not release the investor from liability to the bank arising on account of the bank having executed the instruction before receipt of such amendments/cancellation.</li>
          <li>Investors should ensure that sufficient funds are available in the bank at the time of debit and this authorization is not dishonored. Sometimes it is possible that due to some technical or other reason, installment is not debited on the debit date and is delayed for few days. Please ensure availability of the funds for at least 5 (five) working days after the debit date to avoid dishonors. Ekush Funds will not be responsible for any dishonors raised by the bank and any dispute regarding the same should be taken up with the bank only.</li>
          <li>In case this Authorization is dishonored by the bank, installment for the due date(s), of the dishonored BEFTN debit for the previous month has to be paid in Cheque/ Pay order/ Demand Draft/ Online fund transfer by the investor. Any issue regarding dishonor of his authorization is to be taken up with the bank only. However, Ekush may instruct the bank for BEFTN debit of the same installment/s with the consent of the investor.</li>
          <li>Any queries, questions, comments etc. with regards to Ekush Funds and payment amount will have to raise to Ekush Wealth Management Limited and payments to the bank with regard to the settlement of amounts paid in this regard are committed and not deferrable for any reason whatsoever. The transaction appearing on the account statement will be the proof of payment.</li>
          <li>Under this instruction, the investor cannot dispute regarding the payment to Ekush Funds debited from his/her bank account. If any excess or less than the correct amount is debited, the investor will have to contact to Ekush Wealth Management Limited for clarification. Any type of refund from Ekush Funds on account of this instruction will be settled by Ekush Funds to its investor.</li>
          <li>No SIP installment receipt will be issued by Ekush Funds for BEFTN debit Payments. An annual statement or certificate of SIP payments, as applicable, may be obtained from Ekush Wealth Management Limited upon written request of the investor.</li>
          <li>After maturity the investor may- a) continue the installment amount for another tenure b) keep the matured amount as Non-SIP investment c) transfer the matured amount to the designated bank account of the investor.</li>
          <li>For the auto-renewal option, the investor has to submit another &quot;Auto debit Instruction Form&quot; having validity for another specific period.</li>
          <li>There will be no minimum lot size of units under SIP. Any remaining fraction amount will be converted when it sums up to one unit.</li>
        </ol>
      </div>
    </Modal>
  );
}

function ConfirmModal({
  rows,
  previewHref,
  busy,
  onCancel,
  onConfirm,
}: {
  rows: Array<[string, string]>;
  previewHref: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      title="Confirmation"
      subtitle="Please confirm to submit this instruction for approval"
      footer={
        <>
          <button onClick={onCancel} className="rounded-md bg-red-500 px-4 py-2 text-sm font-medium text-white hover:bg-red-600">
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
          >
            {busy ? "Submitting…" : "Confirm"}
          </button>
        </>
      }
    >
      <div className="mb-6 text-center">
        <a
          href={previewHref}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 rounded-md border-2 border-emerald-700 px-5 py-2.5 text-sm font-medium text-emerald-700 hover:bg-emerald-700 hover:text-white dark:text-emerald-400"
        >
          Preview the DDI form ↗
        </a>
      </div>
      <dl className="space-y-3 rounded-lg bg-zinc-50 p-6 text-sm dark:bg-zinc-950">
        {rows.map(([k, v]) => (
          <Row key={k} label={k} value={v} />
        ))}
      </dl>
    </Modal>
  );
}
