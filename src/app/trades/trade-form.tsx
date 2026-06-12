// Shared buy/sell form, used by /trades/new (create) and
// /trades/[id]/edit (update). Pure markup — the parent passes the option
// lists, the server action, and (for edit) the row's current values.
// Gross is computed server-side; cost basis / realised P&L on SELL are
// derived from prior trades on the same instrument.

type Option = { code: string; name: string };
type BankOption = { id: string; accountName: string; accountType: string | null };
type BrokerOption = {
  code: string;
  name: string;
  brokerBoAccount: string;
  marginLoanAccount: string | null;
  accountNumber: string | null;
};

export type TradeFormInitial = {
  tradeDate: string;
  fiscalYearId: string;
  side: "BUY" | "SELL";
  brokerCode: string;
  instrumentCode: string;
  bankAccount: string;
  quantity: string;
  rate: string;
  commission: string;
  remarks: string;
};

export function TradeForm({
  action,
  fiscalYears,
  instruments,
  banks,
  brokers,
  initial,
  submitLabel,
  hiddenId,
  returnTo,
}: {
  action: (formData: FormData) => Promise<void>;
  fiscalYears: { id: string; label: string }[];
  instruments: Option[];
  banks: BankOption[];
  brokers: BrokerOption[];
  initial: TradeFormInitial;
  submitLabel: string;
  hiddenId?: string;
  returnTo?: string;
}) {
  // When editing, the row's settlement account may be a legacy value not
  // present in the banks/brokers option lists (e.g. an opening-balance or
  // historical margin account). Surface it as a selectable "Current"
  // option so the edit doesn't silently drop it.
  const knownBankValues = new Set<string>([
    ...banks.map((b) => b.accountName),
    ...brokers.flatMap((b) => [b.brokerBoAccount, ...(b.marginLoanAccount ? [b.marginLoanAccount] : [])]),
  ]);
  const showCurrentBank = Boolean(initial.bankAccount) && !knownBankValues.has(initial.bankAccount);

  return (
    <form action={action} className="mt-8 space-y-4">
      {hiddenId && <input type="hidden" name="id" value={hiddenId} />}
      {returnTo && <input type="hidden" name="returnTo" value={returnTo} />}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Trade date" name="tradeDate" type="date" required defaultValue={initial.tradeDate} />
        <SelectField label="Fiscal year" name="fiscalYearId" required defaultValue={initial.fiscalYearId}>
          {fiscalYears.map((y) => (
            <option key={y.id} value={y.id}>
              {y.label}
            </option>
          ))}
        </SelectField>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <SelectField label="Side" name="side" required defaultValue={initial.side}>
          <option value="BUY">BUY</option>
          <option value="SELL">SELL</option>
        </SelectField>
        <SelectField label="Broker" name="brokerCode" defaultValue={initial.brokerCode}>
          {/* Own-fund subscriptions (EFUF / EGF / ESRF) aren't bought
              through a stock broker — they're placed directly with the
              asset manager. Pick this to record the trade with no broker
              (stored as a null brokerCode; the voucher narration reads
              "via EWML (Asset Manager)"). */}
          <option value="">EWML (Asset Manager) — no broker</option>
          {brokers.map((b) => (
            <option key={b.code} value={b.code}>
              {b.name}
            </option>
          ))}
        </SelectField>
        <SelectField label="Instrument" name="instrumentCode" required defaultValue={initial.instrumentCode}>
          <option value="">— pick —</option>
          {instruments.map((i) => (
            <option key={i.code} value={i.code}>
              {i.code} · {i.name}
            </option>
          ))}
        </SelectField>
      </div>

      <div className="grid grid-cols-1 gap-3">
        <SelectField label="Settlement account" name="bankAccount" required defaultValue={initial.bankAccount}>
          <option value="">— pick —</option>
          {showCurrentBank && (
            <optgroup label="Current">
              <option value={initial.bankAccount}>{initial.bankAccount}</option>
            </optgroup>
          )}
          <optgroup label="Banks">
            {banks
              .filter((b) => b.accountType !== "mobile_money")
              .map((b) => (
                <option key={b.id} value={b.accountName}>
                  {b.accountName}
                </option>
              ))}
          </optgroup>
          <optgroup label="Brokers (BO + Margin)">
            {brokers.flatMap((b) => {
              const bo = (
                <option key={`${b.code}-bo`} value={b.brokerBoAccount}>
                  {b.name} — BO{b.accountNumber ? ` (${b.accountNumber})` : ""}
                </option>
              );
              return b.marginLoanAccount
                ? [
                    bo,
                    <option key={`${b.code}-margin`} value={b.marginLoanAccount}>
                      {b.name} — Margin Loan
                    </option>,
                  ]
                : [bo];
            })}
          </optgroup>
          <optgroup label="Mobile money">
            {banks
              .filter((b) => b.accountType === "mobile_money")
              .map((b) => (
                <option key={b.id} value={b.accountName}>
                  {b.accountName}
                </option>
              ))}
          </optgroup>
        </SelectField>
      </div>

      <div className="grid grid-cols-4 gap-3">
        <Field label="Quantity" name="quantity" type="number" step="0.0001" min="0" required defaultValue={initial.quantity} />
        <Field label="Rate (BDT)" name="rate" type="number" step="0.000001" min="0" required defaultValue={initial.rate} />
        <div>
          <Field
            label="Commission (BDT)"
            name="commission"
            type="number"
            step="0.01"
            min="0"
            defaultValue={initial.commission}
          />
          <p className="mt-1 text-[10px] text-zinc-500">Added to BUY cost · netted from SELL proceeds.</p>
        </div>
        <div>
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wider text-zinc-600 dark:text-zinc-400">
              Gross
            </span>
            <input
              disabled
              placeholder="qty × rate"
              className="mt-1 block w-full rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950"
            />
          </label>
          <p className="mt-1 text-[10px] text-zinc-500">Calculated server-side.</p>
        </div>
      </div>

      <Field label="Remarks (optional)" name="remarks" placeholder="P Buy / IPO / Right share / …" defaultValue={initial.remarks} />

      <button
        type="submit"
        className="mt-2 w-full rounded-md bg-zinc-900 py-2.5 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
      >
        {submitLabel}
      </button>
    </form>
  );
}

function Field({
  label,
  name,
  type = "text",
  required = false,
  defaultValue,
  placeholder,
  step,
  min,
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  defaultValue?: string;
  placeholder?: string;
  step?: string;
  min?: string;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium uppercase tracking-wider text-zinc-600 dark:text-zinc-400">{label}</span>
      <input
        name={name}
        type={type}
        required={required}
        defaultValue={defaultValue}
        placeholder={placeholder}
        step={step}
        min={min}
        className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
      />
    </label>
  );
}

function SelectField({
  label,
  name,
  required = false,
  defaultValue,
  children,
}: {
  label: string;
  name: string;
  required?: boolean;
  defaultValue?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium uppercase tracking-wider text-zinc-600 dark:text-zinc-400">{label}</span>
      <select
        name={name}
        required={required}
        defaultValue={defaultValue}
        className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
      >
        {children}
      </select>
    </label>
  );
}
