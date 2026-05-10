// Contract for the future Ekush Web investor API (spec §7).
// X-System reads from this shape; the real backend will conform to it.
//
// GET /api/v1/investors?agent_code=SB0001
// Authorization: Bearer <signed-service-token>

export type FundCode = "EFUF" | "EGF" | "ESRF";

export const EQUITY_FUNDS: ReadonlyArray<FundCode> = ["EFUF", "EGF"];
export const FIXED_INCOME_FUNDS: ReadonlyArray<FundCode> = ["ESRF"];

export function categoryForFund(fund: FundCode): "equity" | "fixed_income" {
  return EQUITY_FUNDS.includes(fund) ? "equity" : "fixed_income";
}

export type Redemption = {
  /** ISO date YYYY-MM-DD */
  date: string;
  units: number;
  gross: number;
};

export type EkushWebInvestor = {
  investor_code: string;
  full_name: string;
  fund_code: FundCode;
  /** ISO date — original investment date that anchors trail-tier rollover. */
  sourced_on: string;
  initial_units: number;
  unit_price_at_sourcing: number;
  /** Units still held under this agent's code after any redemptions. */
  units_outstanding: number;
  redemptions: Redemption[];
  /** True iff investor went direct (no agent commission ever — clause 6.5). */
  is_direct_subscription: boolean;
  /** Year-to-date management fee charged on this holding (informational). */
  management_fee_charged_ytd: number;
};
