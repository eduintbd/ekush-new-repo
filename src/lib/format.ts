// BDT formatting helpers — Bangladesh uses the Indian numbering system
// (1,23,45,000 not 12,345,000) per spec §12.

const bdtFormatter = new Intl.NumberFormat("en-IN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatBdt(n: number | string | { toString(): string } | null | undefined): string {
  if (n === null || n === undefined) return "—";
  const num = typeof n === "number" ? n : Number(n.toString());
  if (!Number.isFinite(num)) return "—";
  return bdtFormatter.format(num);
}

export function formatBdtCurrency(n: number | string | { toString(): string } | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return `BDT ${formatBdt(n)}`;
}
