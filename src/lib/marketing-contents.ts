// Categories for marketing content an admin uploads for agents to share. Kept
// as a small list so the admin can group flyers, fund one-pagers, etc.

export const MARKETING_CATEGORIES = [
  "general",
  "fund-flyer",
  "brochure",
  "form",
  "social",
] as const;

export type MarketingCategory = (typeof MARKETING_CATEGORIES)[number];

const SET: ReadonlySet<string> = new Set(MARKETING_CATEGORIES);

export function isMarketingCategory(value: string): value is MarketingCategory {
  return SET.has(value);
}

export const MARKETING_LABELS: Record<MarketingCategory, string> = {
  general: "General",
  "fund-flyer": "Fund flyer",
  brochure: "Brochure",
  form: "Form",
  social: "Social media",
};
