"use server";

import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { consumeRecoveryCodeAndResetMfa } from "@/lib/mfa";

/**
 * Verify a recovery code from a user who has signed in with password but
 * lost their authenticator. On success: clears the user's MFA factors,
 * signs them out, and redirects to /login so they sign in fresh — the
 * post-login flow will then force them through /account/mfa to enrol
 * a new device.
 *
 * The user MUST be in an AAL1 session (password verified, MFA challenge
 * pending). We refuse if the session is already AAL2 (paranoia: a stolen
 * AAL2 session shouldn't use this to clear factors).
 */
export async function verifyRecoveryCode(formData: FormData): Promise<void> {
  const code = String(formData.get("code") ?? "").trim();
  const portal = String(formData.get("portal") ?? "staff") as "staff" | "agent";
  const errorReturn = portal === "agent" ? "/agent/login/mfa/recovery" : "/login/mfa/recovery";
  const finalLoginPage = portal === "agent" ? "/agent/login" : "/login";

  if (!code) {
    redirect(`${errorReturn}?error=Enter+a+recovery+code.`);
  }

  const supabase = await createSupabaseServerClient();
  const { data: u } = await supabase.auth.getUser();
  if (!u.user) {
    // Session expired — bounce to login.
    redirect(`${finalLoginPage}?error=Session+expired.+Sign+in+again.`);
  }

  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal?.currentLevel === "aal2") {
    redirect(`${errorReturn}?error=Already+verified+for+this+session.`);
  }

  const result = await consumeRecoveryCodeAndResetMfa(u.user!.id, code);

  if (!result.ok) {
    const msg =
      result.reason === "admin_unavailable"
        ? "Recovery is disabled on this deployment (SUPABASE_SERVICE_ROLE_KEY not set). Contact an admin."
        : result.reason === "unenroll_failed"
          ? "Could not remove your MFA factors. Try again or contact an admin."
          : "That code did not match.";
    redirect(`${errorReturn}?error=${encodeURIComponent(msg)}`);
  }

  console.log(
    JSON.stringify({
      event: "mfa.recovery_consumed",
      userId: u.user!.id,
      portal,
      at: new Date().toISOString(),
    }),
  );

  await supabase.auth.signOut();
  redirect(
    `${finalLoginPage}?ok=${encodeURIComponent(
      "Recovery successful. Sign in again — you'll be asked to enrol a new authenticator.",
    )}`,
  );
}
