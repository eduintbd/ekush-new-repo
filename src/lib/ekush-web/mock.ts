// Deterministic mock for Ekush Web GET /api/v1/investors (spec §7).
// Same agent_code yields the same investors every call so screenshots
// and tests stay stable. The agent code seeds a small PRNG.

import type { EkushWebInvestor, FundCode } from "./types";

const FUNDS: FundCode[] = ["EFUF", "EGF", "ESRF"];

function hashSeed(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  }
  return h >>> 0;
}

function* prng(seed: number): Generator<number> {
  let s = seed || 1;
  while (true) {
    s = (s * 1664525 + 1013904223) >>> 0;
    yield s / 0x100000000;
  }
}

function pad(n: number, len: number): string {
  return String(n).padStart(len, "0");
}

function isoDateDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * Returns 0–6 deterministic investors for the given agent_code.
 * SB0001 always returns the canonical demo cohort used in spec §14.
 */
export function mockInvestorsForAgent(agentCode: string): EkushWebInvestor[] {
  if (agentCode === "SB0000") return [];
  if (agentCode === "SB0001") return canonicalDemoCohort();

  const rng = prng(hashSeed(agentCode));
  const next = () => rng.next().value;
  const count = 1 + Math.floor(next() * 5); // 1..5 investors
  const out: EkushWebInvestor[] = [];
  for (let i = 0; i < count; i++) {
    const fund = FUNDS[Math.floor(next() * FUNDS.length)];
    const sourcedDaysAgo = 30 + Math.floor(next() * 720); // 1mo..2yr ago
    const initialUnits = Math.round((1000 + next() * 9000) * 100) / 100;
    const unitPrice = Math.round((10 + next() * 5) * 100) / 100;
    const isDirect = next() < 0.1;
    const redemptions = next() < 0.25
      ? [{
          date: isoDateDaysAgo(Math.floor(sourcedDaysAgo / 2)),
          units: Math.round(initialUnits * (0.1 + next() * 0.2) * 100) / 100,
          gross: 0, // filled below
        }]
      : [];
    if (redemptions.length > 0) {
      redemptions[0].gross = Math.round(redemptions[0].units * unitPrice * 100) / 100;
    }
    const unitsOutstanding =
      initialUnits - redemptions.reduce((s, r) => s + r.units, 0);

    out.push({
      investor_code: `A${pad(hashSeed(agentCode + i) % 99999, 5)}`,
      full_name: makeName(next),
      fund_code: fund,
      sourced_on: isoDateDaysAgo(sourcedDaysAgo),
      initial_units: initialUnits,
      unit_price_at_sourcing: unitPrice,
      units_outstanding: Math.max(0, Math.round(unitsOutstanding * 100) / 100),
      redemptions,
      is_direct_subscription: isDirect,
      management_fee_charged_ytd: Math.round(initialUnits * unitPrice * 0.01 * 100) / 100,
    });
  }
  return out;
}

function makeName(next: () => number): string {
  const first = ["Sadia", "Imran", "Anika", "Rakib", "Tasneem", "Faisal", "Nadia", "Arif"];
  const last = ["Ahmed", "Khan", "Hossain", "Rahman", "Chowdhury", "Islam", "Akhter"];
  return `${first[Math.floor(next() * first.length)]} ${last[Math.floor(next() * last.length)]}`;
}

function canonicalDemoCohort(): EkushWebInvestor[] {
  return [
    {
      investor_code: "A00021",
      full_name: "Sadia Ahmed",
      fund_code: "EGF",
      sourced_on: "2025-08-12",
      initial_units: 1500.0,
      unit_price_at_sourcing: 10.68,
      units_outstanding: 1200.0,
      redemptions: [{ date: "2026-01-05", units: 300, gross: 3825.6 }],
      is_direct_subscription: false,
      management_fee_charged_ytd: 4250.0,
    },
    {
      investor_code: "A00042",
      full_name: "Faisal Hossain",
      fund_code: "ESRF",
      sourced_on: "2024-11-01",
      initial_units: 2500.0,
      unit_price_at_sourcing: 10.12,
      units_outstanding: 2500.0,
      redemptions: [],
      is_direct_subscription: false,
      management_fee_charged_ytd: 1800.0,
    },
  ];
}
