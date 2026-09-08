"use client";

// Investor picker with a search box — the same principle as the portal's
// /admin/investors table search ("Search: [Code or name…]"), applied to the
// places in the sales module where an investor is chosen from a dropdown.
//
// The dropdown stays: the search box narrows what it contains rather than
// replacing it, so an agent who knows the code types it and an agent who
// doesn't can still scroll the list. Filtering is client-side and instant —
// these forms are mid-flow (a purchase wizard, a SIP mandate, a link form
// inside a <details>), so a round-trip that reloaded the page would throw
// away everything else already filled in.
//
// Matching is case-insensitive substring over both the code and the name,
// exactly what the portal's `investorCode contains … OR name contains …`
// query does.

import { useMemo, useState } from "react";

export type InvestorSearchOption = {
  /** The value submitted / reported — an investor code. */
  code: string;
  /** What the option reads as, e.g. "A00005 — MORSHEDA MIM". */
  label: string;
};

export function InvestorSearchSelect({
  options,
  value,
  defaultValue,
  onChange,
  name,
  required,
  id,
  placeholderOption,
  selectClassName,
  searchPlaceholder = "Code or name…",
}: {
  options: InvestorSearchOption[];
  /** Controlled value. Omit to let the component hold its own. */
  value?: string;
  defaultValue?: string;
  onChange?: (code: string) => void;
  /** Set when the select is submitted as part of a form. */
  name?: string;
  required?: boolean;
  id?: string;
  /** e.g. "— pick an investor —". Omit for an always-populated select. */
  placeholderOption?: string;
  selectClassName?: string;
  searchPlaceholder?: string;
}) {
  const [query, setQuery] = useState("");
  const [internal, setInternal] = useState(defaultValue ?? "");
  const selected = value !== undefined ? value : internal;

  const filtered = useMemo(() => matches(options, query), [options, query]);

  function select(next: string) {
    if (value === undefined) setInternal(next);
    onChange?.(next);
  }

  // Narrowing the list can hide whatever is currently selected, which would
  // leave the select showing one investor while the form holds another.
  // Move the selection onto the first match instead — unless there is a
  // placeholder option to fall back to, in which case clear it so the admin
  // has to make a deliberate choice.
  function onQuery(next: string) {
    setQuery(next);
    const nextList = matches(options, next);
    if (selected && !nextList.some((o) => o.code === selected)) {
      select(placeholderOption ? "" : (nextList[0]?.code ?? ""));
    }
  }

  const searchId = id ? `${id}-search` : undefined;

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <label
          htmlFor={searchId}
          className="text-[11px] text-zinc-500 dark:text-zinc-400"
        >
          Search:
        </label>
        <input
          id={searchId}
          type="text"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder={searchPlaceholder}
          // Enter inside a search box should never submit the surrounding
          // form — on the SIP and link forms that would raise the order.
          onKeyDown={(e) => {
            if (e.key === "Enter") e.preventDefault();
          }}
          className="w-48 rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900 placeholder:text-zinc-400 focus:border-emerald-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
        />
        {query ? (
          <button
            type="button"
            onClick={() => onQuery("")}
            className="text-[11px] text-zinc-500 hover:text-emerald-600 dark:text-zinc-400"
          >
            Clear
          </button>
        ) : null}
        {query ? (
          <span className="text-[11px] tabular-nums text-zinc-500">
            {filtered.length} of {options.length}
          </span>
        ) : null}
      </div>

      <select
        id={id}
        name={name}
        required={required}
        value={selected}
        onChange={(e) => select(e.target.value)}
        className={
          selectClassName ??
          "w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:[color-scheme:dark]"
        }
      >
        {placeholderOption ? <option value="">{placeholderOption}</option> : null}
        {filtered.map((o) => (
          <option key={o.code} value={o.code}>
            {o.label}
          </option>
        ))}
      </select>

      {query && filtered.length === 0 ? (
        <p className="text-[11px] text-amber-600 dark:text-amber-400">
          No investor matches “{query}”.
        </p>
      ) : null}
    </div>
  );
}

function matches(
  options: InvestorSearchOption[],
  query: string,
): InvestorSearchOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return options;
  return options.filter(
    (o) =>
      o.code.toLowerCase().includes(q) || o.label.toLowerCase().includes(q),
  );
}
