"use client";

// Fund selection + "what was sourced" figures for the link-investor form on
// /admin/agents/[id].
//
// The fund was a single <select>, so linking one investor across several funds
// meant submitting the whole form once per fund — the agent pages show the
// same investor code repeated three times, one row per fund, sourced the same
// day. Checkboxes make that one submit.
//
// These four controls live in one component because a rule ties them
// together. Initial units and unit price describe ONE purchase in ONE fund: a
// figure entered against three checked funds has no meaning, and silently
// copying it into all three would invent holdings that were never bought. So
// they enable only while exactly one fund is checked, and the reason is shown
// rather than left to be discovered on a rejected submit. The server enforces
// the same rule — this is the explanation, not the gate.
//
// Renders a fragment, not a wrapper: the parent is a CSS grid and these need
// to stay direct grid children.

import { useState } from "react";

const FUNDS = [
  ["EFUF", "Ekush First Unit Fund"],
  ["EGF", "Ekush Growth Fund"],
  ["ESRF", "Ekush Stable Return Fund"],
] as const;

const numberClass =
  "mt-1 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 font-mono disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:disabled:bg-zinc-950 dark:disabled:text-zinc-600";

const captionClass =
  "text-[10px] font-medium uppercase tracking-wider text-zinc-500";

export function LinkFundFields() {
  const [checked, setChecked] = useState<string[]>([]);
  const single = checked.length === 1;

  function toggle(code: string, on: boolean) {
    setChecked((prev) => (on ? [...prev, code] : prev.filter((c) => c !== code)));
  }

  return (
    <>
      <div className="col-span-2 sm:col-span-3">
        <span className={captionClass}>Funds *</span>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-2">
          {FUNDS.map(([code, name]) => (
            <label key={code} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                name="fundCodes"
                value={code}
                checked={checked.includes(code)}
                onChange={(e) => toggle(code, e.target.checked)}
                // Browsers have no "at least one of this group" rule. Marking
                // every box required while none is ticked gets the native
                // message and blocks submit; the moment one is ticked the
                // constraint lifts so the others stay optional.
                required={checked.length === 0}
                className="h-3.5 w-3.5 accent-emerald-600"
              />
              <span className="font-mono text-xs text-zinc-900 dark:text-zinc-100">
                {code}
              </span>
              <span className="text-[11px] text-zinc-500">{name}</span>
            </label>
          ))}
        </div>
        <p className="mt-1 text-[11px] text-zinc-500">
          {checked.length > 1
            ? `${checked.length} funds — one link each, all sourced on the date below. Initial units and unit price are off: they describe a single purchase in one fund.`
            : "Tick every fund this agent sourced the investor into. Tick exactly one to also record the initial units and price."}
        </p>
      </div>

      <label className="block">
        <span className={captionClass}>Initial units</span>
        <input
          type="number"
          step="0.0001"
          min="0"
          name="initialUnits"
          disabled={!single}
          className={numberClass}
        />
      </label>
      <label className="block">
        <span className={captionClass}>Unit price at sourcing</span>
        <input
          type="number"
          step="0.0001"
          min="0"
          name="unitPriceAtSourcing"
          disabled={!single}
          className={numberClass}
        />
      </label>
      <label className="block">
        <span className={captionClass}>
          Initial gross amount (optional — auto if blank)
        </span>
        <input
          type="number"
          step="0.01"
          min="0"
          name="initialGrossAmount"
          disabled={!single}
          className={numberClass}
        />
      </label>
    </>
  );
}
