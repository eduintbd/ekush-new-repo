"use client";

// Interactive commission calculator. Recomputes live as the agent changes the
// amount, tenor or fund. The chart is a self-contained inline SVG (no chart
// library) mirroring the portal's SIP projection card.

import { useMemo, useState } from "react";
import { forecastCommission, bdt } from "@/lib/commission-forecast";

export interface CalcFund {
  code: string;
  name: string;
  category: "equity" | "fixed_income";
  cagr: number | null;
  cagrYears: number | null;
  currentNav: number;
  upfrontRate: number;
  trailY1Rate: number;
  trailY2Rate: number;
}

const ORANGE = "#F27023";
const AMOUNT_CHIPS = [100000, 500000, 1000000, 2500000, 5000000];

export default function CalculatorClient({ funds }: { funds: CalcFund[] }) {
  const [amount, setAmount] = useState(1000000);
  const [tenor, setTenor] = useState(2);
  const [fundCode, setFundCode] = useState(funds[0]?.code ?? "");

  const fund = funds.find((f) => f.code === fundCode) ?? funds[0];
  // Fall back to a sensible market assumption if a fund has no CAGR history yet.
  const cagrPct = fund.cagr ?? 10;
  const cagrKnown = fund.cagr !== null;

  const result = useMemo(
    () =>
      forecastCommission({
        amount,
        tenorYears: tenor,
        cagrPct,
        upfrontRate: fund.upfrontRate,
        trailY1Rate: fund.trailY1Rate,
        trailY2Rate: fund.trailY2Rate,
      }),
    [amount, tenor, cagrPct, fund.upfrontRate, fund.trailY1Rate, fund.trailY2Rate],
  );

  const trailPctLabel = `${(fund.trailY1Rate * 100).toFixed(2)}%${
    fund.trailY2Rate !== fund.trailY1Rate ? ` → ${(fund.trailY2Rate * 100).toFixed(2)}%` : ""
  }`;

  return (
    <div className="space-y-6">
      {/* Inputs */}
      <div className="grid gap-5 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900 sm:grid-cols-2">
        <div>
          <label className="block text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
            Investment amount (BDT)
          </label>
          <input
            type="number"
            min={0}
            step={10000}
            value={amount}
            onChange={(e) => setAmount(Math.max(0, Number(e.target.value) || 0))}
            className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-lg font-semibold tabular-nums dark:border-zinc-700 dark:bg-zinc-900"
          />
          <div className="mt-2 flex flex-wrap gap-1.5">
            {AMOUNT_CHIPS.map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setAmount(v)}
                className={`rounded-full px-3 py-1 text-xs font-medium ${
                  amount === v
                    ? "bg-[#F27023] text-white"
                    : "border border-zinc-300 text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300"
                }`}
              >
                ৳{bdt(v)}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
            Tenor — {tenor} {tenor === 1 ? "year" : "years"}
          </label>
          <input
            type="range"
            min={1}
            max={10}
            step={1}
            value={tenor}
            onChange={(e) => setTenor(Number(e.target.value))}
            className="mt-3 block w-full accent-[#F27023]"
          />
          <div className="mt-1 flex justify-between text-[10px] text-zinc-400">
            <span>1y</span><span>5y</span><span>10y</span>
          </div>

          <label className="mt-4 block text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
            Fund
          </label>
          <select
            value={fundCode}
            onChange={(e) => setFundCode(e.target.value)}
            className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          >
            {funds.map((f) => (
              <option key={f.code} value={f.code}>
                {f.name} ({f.code})
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Fund facts */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Fund CAGR" value={cagrKnown ? `${cagrPct.toFixed(2)}%` : `${cagrPct}% (assumed)`}
          hint={cagrKnown ? `real, over ${fund.cagrYears}y` : "no history yet"} />
        <Stat label="Current NAV" value={fund.currentNav.toFixed(4)} hint="latest" />
        <Stat label="Your upfront rate" value={`${(fund.upfrontRate * 100).toFixed(2)}%`} hint="one time" />
        <Stat label="Your trail rate" value={trailPctLabel} hint="per year (Y1 → Y2+)" />
      </div>

      {/* Headline results */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Upfront (one time)" value={`৳${bdt(result.upfront, 2)}`} muted />
        <Stat label={`Trail over ${tenor}y`} value={`৳${bdt(result.totalTrail, 2)}`} />
        <Stat label="First month's trail" value={`৳${bdt(result.firstMonthTrail, 2)}`} hint="the monthly forecast" muted />
        <Stat label="Total commission" value={`৳${bdt(result.totalCommission, 2)}`} emphasis />
      </div>

      {/* Chart */}
      <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-3 flex items-baseline justify-between">
          <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
            Your commission builds up over {tenor} {tenor === 1 ? "year" : "years"}
          </p>
          <p className="text-xs text-zinc-500">
            on ৳{bdt(amount)} in {fund.code}
          </p>
        </div>
        <CommissionChart series={result.series} tenorYears={tenor} />
        <p className="mt-3 text-[11px] leading-relaxed text-zinc-500">
          The investor&apos;s money is projected to grow at the fund&apos;s CAGR, and your monthly
          trail grows with it. Upfront is paid once at the start. This is an estimate for
          guidance — actual commission is confirmed when the office posts each run, and past
          performance does not guarantee future returns.
        </p>
      </div>
    </div>
  );
}

/** Self-contained inline-SVG line + area chart of cumulative commission. */
function CommissionChart({
  series,
  tenorYears,
}: {
  series: Array<{ month: number; cumulativeCommission: number }>;
  tenorYears: number;
}) {
  const W = 600;
  const H = 220;
  const padL = 8;
  const padR = 8;
  const padT = 12;
  const padB = 24;

  const maxY = niceCeil(Math.max(1, ...series.map((p) => p.cumulativeCommission)));
  const maxMonth = Math.max(1, series[series.length - 1]?.month ?? 1);

  const xOf = (month: number) => padL + (month / maxMonth) * (W - padL - padR);
  const yOf = (val: number) => padT + (1 - val / maxY) * (H - padT - padB);

  const linePts = series.map((p) => `${xOf(p.month).toFixed(1)},${yOf(p.cumulativeCommission).toFixed(1)}`);
  const linePath = `M ${linePts.join(" L ")}`;
  const areaPath = `${linePath} L ${xOf(maxMonth).toFixed(1)},${yOf(0).toFixed(1)} L ${xOf(0).toFixed(1)},${yOf(0).toFixed(1)} Z`;

  const last = series[series.length - 1];
  const yearTicks = Array.from({ length: tenorYears + 1 }, (_, y) => y);

  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ minWidth: 320 }} role="img"
        aria-label="Cumulative commission over the tenor">
        <defs>
          <linearGradient id="commfill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={ORANGE} stopOpacity="0.28" />
            <stop offset="100%" stopColor={ORANGE} stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {/* horizontal gridlines */}
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <g key={f}>
            <line x1={padL} x2={W - padR} y1={yOf(maxY * f)} y2={yOf(maxY * f)}
              stroke="currentColor" strokeOpacity="0.08" />
            <text x={padL} y={yOf(maxY * f) - 3} fontSize="9" fill="currentColor" fillOpacity="0.4">
              ৳{bdt(Math.round(maxY * f))}
            </text>
          </g>
        ))}

        <path d={areaPath} fill="url(#commfill)" />
        <path d={linePath} fill="none" stroke={ORANGE} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />

        {/* endpoint dot */}
        {last && (
          <circle cx={xOf(last.month)} cy={yOf(last.cumulativeCommission)} r="4" fill={ORANGE} />
        )}

        {/* year ticks */}
        {yearTicks.map((y) => (
          <text key={y} x={xOf(y * 12)} y={H - 6} fontSize="9" textAnchor="middle"
            fill="currentColor" fillOpacity="0.45">
            Y{y}
          </text>
        ))}
      </svg>
    </div>
  );
}

function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / mag;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * mag;
}

function Stat({
  label,
  value,
  hint,
  emphasis = false,
  muted = false,
}: {
  label: string;
  value: string;
  hint?: string;
  emphasis?: boolean;
  muted?: boolean;
}) {
  return (
    <div
      className={`rounded-md border p-3 ${
        emphasis
          ? "border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950"
          : muted
            ? "border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950"
            : "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"
      }`}
    >
      <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">{label}</p>
      <p
        className={`mt-0.5 font-mono tabular-nums ${
          emphasis ? "text-lg font-bold text-emerald-800 dark:text-emerald-200" : "text-base text-zinc-900 dark:text-zinc-100"
        }`}
      >
        {value}
      </p>
      {hint && <p className="mt-0.5 text-[10px] text-zinc-500">{hint}</p>}
    </div>
  );
}
