// Combined account-holder name for jointly-held accounts.
//
// Ported verbatim from the portal (apps/portal/src/lib/account-name.ts) so the
// agent's statement PDFs name the account exactly as the portal's do — a joint
// holding must read "PRINCIPAL & JOINT" on both, or the two documents look
// like they describe different accounts.
export function accountHolderName(
  inv: { name: string; jointApplicantName?: string | null },
): string {
  const joint = inv.jointApplicantName?.trim();
  return joint ? `${inv.name} & ${joint}` : inv.name;
}
