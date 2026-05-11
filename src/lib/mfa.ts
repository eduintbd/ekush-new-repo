// MFA (TOTP) helpers built on Supabase Auth's MFA API.
//
// Spec §11 / task 12: admin + accountant MUST enrol a TOTP factor and
// step up their session to AAL2 to access the staff portal. Auditor and
// selling-agent roles MAY enrol but are not forced — auditor is read-
// only and the agent portal is lower-stakes.
//
// Page-level guards live in src/lib/auth.ts; login/agent sign-in actions
// also check assurance level so users with an existing factor get
// redirected to /login/mfa for a challenge instead of landing on the
// dashboard at AAL1.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { UserRole } from "@/generated/prisma";

export const MFA_REQUIRED_ROLES: ReadonlyArray<UserRole> = ["admin", "accountant"];

/** True iff the role must be at AAL2 to use the portal. */
export function mfaRequiredForRole(role: UserRole | null | undefined): boolean {
  return role !== null && role !== undefined && MFA_REQUIRED_ROLES.includes(role);
}

export type MfaStatus = {
  /** Verified TOTP factors. Empty array if user has only unverified enrollments. */
  verifiedFactors: Array<{ id: string; friendlyName: string | null; createdAt: string }>;
  /** Unverified factors (enrolled but not yet verified — should be cleaned up or completed). */
  unverifiedFactors: Array<{ id: string; friendlyName: string | null; createdAt: string }>;
  /** Current and next AAL for the session. */
  currentLevel: "aal1" | "aal2" | null;
  nextLevel: "aal1" | "aal2" | null;
};

export async function getMfaStatus(supabase: SupabaseClient): Promise<MfaStatus> {
  const { data: factorsData, error: factorsErr } = await supabase.auth.mfa.listFactors();
  if (factorsErr) {
    return {
      verifiedFactors: [],
      unverifiedFactors: [],
      currentLevel: null,
      nextLevel: null,
    };
  }
  const all = factorsData?.all ?? [];
  const verifiedFactors = all
    .filter((f) => f.status === "verified")
    .map((f) => ({ id: f.id, friendlyName: f.friendly_name ?? null, createdAt: f.created_at }));
  const unverifiedFactors = all
    .filter((f) => f.status !== "verified")
    .map((f) => ({ id: f.id, friendlyName: f.friendly_name ?? null, createdAt: f.created_at }));

  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  const currentLevel = (aal?.currentLevel ?? null) as MfaStatus["currentLevel"];
  const nextLevel = (aal?.nextLevel ?? null) as MfaStatus["nextLevel"];

  return { verifiedFactors, unverifiedFactors, currentLevel, nextLevel };
}

/** True iff the session has at least AAL2 (MFA verified for this session). */
export function isStepped(status: MfaStatus): boolean {
  return status.currentLevel === "aal2";
}

/** True iff the user has any verified factor (regardless of session AAL). */
export function hasVerifiedFactor(status: MfaStatus): boolean {
  return status.verifiedFactors.length > 0;
}
