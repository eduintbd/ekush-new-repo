// MFA (TOTP) helpers built on Supabase Auth's MFA API + recovery codes.
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
//
// Recovery codes: bcrypt-hashed single-use codes stored in `MfaRecoveryCode`.
// On match, the recovery flow uses the service-role client to unenrol
// the user's MFA factors so they can re-enrol on next sign-in.

import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { prisma } from "@/lib/prisma";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
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

// ─── Recovery codes ──────────────────────────────────────────────

/** Number of recovery codes generated per request. Industry standard ~10. */
export const RECOVERY_CODE_COUNT = 10;
/** Bcrypt cost; 10 is fast enough for ~10-of-N checks on each redemption. */
const BCRYPT_COST = 10;

/** Format a 15-byte random buffer as `xxxx-xxxx-xxxx-xxx` base32. */
function formatCode(): string {
  // 9 random bytes → 14 base32 chars; we slice to 12 and group 4-4-4.
  const raw = randomBytes(9).toString("base64url").replace(/[-_]/g, "").slice(0, 12).toUpperCase();
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

/** Normalise user input: strip whitespace and dashes, uppercase. */
export function normaliseRecoveryCode(input: string): string {
  return input.replace(/[\s-]/g, "").toUpperCase();
}

/**
 * Replace any existing unused codes for this user with a fresh batch.
 * Returns the plaintext codes — the caller MUST display these once and
 * never again (the DB only stores hashes).
 */
export async function generateRecoveryCodes(userId: string): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, formatCode);
  const hashes = await Promise.all(
    codes.map((c) => bcrypt.hash(normaliseRecoveryCode(c), BCRYPT_COST)),
  );

  await prisma.$transaction([
    // Invalidate any prior unused codes — issuing new codes burns the old set.
    prisma.mfaRecoveryCode.deleteMany({ where: { userId, usedAt: null } }),
    prisma.mfaRecoveryCode.createMany({
      data: codes.map((_, i) => ({
        userId,
        codeHash: hashes[i],
        label: `Code ${i + 1}`,
      })),
    }),
  ]);

  return codes;
}

/** How many unused recovery codes the user has. */
export async function countActiveRecoveryCodes(userId: string): Promise<number> {
  try {
    return await prisma.mfaRecoveryCode.count({ where: { userId, usedAt: null } });
  } catch {
    return 0;
  }
}

/**
 * Verify a user-supplied recovery code. On match, marks the code used and
 * uses the Supabase service-role client to unenrol the user's MFA factors
 * so they can re-enrol on next sign-in.
 *
 * Returns { ok: true } on success, or an error reason on failure. Failure
 * reasons are intentionally generic to avoid revealing whether the userId
 * exists.
 */
export async function consumeRecoveryCodeAndResetMfa(
  userId: string,
  rawCode: string,
): Promise<{ ok: true } | { ok: false; reason: "invalid" | "admin_unavailable" | "unenroll_failed" }> {
  const code = normaliseRecoveryCode(rawCode);
  if (!/^[A-Z0-9]{12}$/.test(code)) return { ok: false, reason: "invalid" };

  const candidates = await prisma.mfaRecoveryCode.findMany({
    where: { userId, usedAt: null },
    orderBy: { createdAt: "asc" },
  });

  let matched: { id: string } | null = null;
  for (const c of candidates) {
    if (await bcrypt.compare(code, c.codeHash)) {
      matched = { id: c.id };
      break;
    }
  }
  if (!matched) return { ok: false, reason: "invalid" };

  const admin = createSupabaseAdminClient();
  if (!admin) return { ok: false, reason: "admin_unavailable" };

  // Unenrol every MFA factor the user has. Failure here means we leave the
  // code unused so the user can retry.
  const { data: factorList, error: listErr } = await admin.auth.admin.mfa.listFactors({ userId });
  if (listErr) return { ok: false, reason: "unenroll_failed" };
  for (const f of factorList?.factors ?? []) {
    const { error: rmErr } = await admin.auth.admin.mfa.deleteFactor({
      userId,
      id: f.id,
    });
    if (rmErr) return { ok: false, reason: "unenroll_failed" };
  }

  // Mark the code consumed only after factors are actually removed.
  await prisma.mfaRecoveryCode.update({
    where: { id: matched.id },
    data: { usedAt: new Date() },
  });

  return { ok: true };
}
