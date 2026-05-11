"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { generateRecoveryCodes } from "@/lib/mfa";

/**
 * Begin TOTP enrolment. Returns the unverified factor id, the SVG QR
 * code, and the raw secret to render to the user.
 * Called from a Client Component (the enrolment wizard).
 */
export async function enrolTotp(): Promise<
  | { ok: true; factorId: string; qrCodeSvg: string; secret: string; uri: string }
  | { ok: false; error: string }
> {
  const supabase = await createSupabaseServerClient();
  const friendlyName = `Authenticator ${new Date().toISOString().slice(0, 10)}`;
  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: "totp",
    friendlyName,
    issuer: "Ekush ERP",
  });
  if (error || !data || data.type !== "totp") {
    return { ok: false, error: error?.message ?? "Could not begin enrolment." };
  }
  return {
    ok: true,
    factorId: data.id,
    qrCodeSvg: data.totp.qr_code,
    secret: data.totp.secret,
    uri: data.totp.uri,
  };
}

/** Verify the 6-digit code from the authenticator app to complete enrolment. */
export async function verifyEnrolment(formData: FormData): Promise<void> {
  const factorId = String(formData.get("factorId") ?? "");
  const code = String(formData.get("code") ?? "").trim();

  if (!factorId || !/^\d{6}$/.test(code)) {
    redirect("/account/mfa?error=Enter+the+6-digit+code+from+your+authenticator.");
  }

  const supabase = await createSupabaseServerClient();
  const { data: challengeData, error: challengeErr } = await supabase.auth.mfa.challenge({
    factorId,
  });
  if (challengeErr || !challengeData) {
    redirect("/account/mfa?error=Could+not+start+verification.+Try+again.");
  }
  const { error: verifyErr } = await supabase.auth.mfa.verify({
    factorId,
    challengeId: challengeData!.id,
    code,
  });
  if (verifyErr) {
    const { data: u } = await supabase.auth.getUser();
    console.warn(JSON.stringify({ event: "mfa.verify_fail", phase: "enrolment", userId: u.user?.id, factorId, at: new Date().toISOString() }));
    redirect("/account/mfa?error=That+code+did+not+match.+Try+the+latest+code+from+your+app.");
  }

  const { data: u } = await supabase.auth.getUser();
  console.log(JSON.stringify({ event: "mfa.enrolled", userId: u.user?.id, factorId, at: new Date().toISOString() }));
  revalidatePath("/account/mfa");
  redirect("/account/mfa?ok=Enrolled");
}

/** Remove an enrolled (or unverified) factor. */
export async function unenrol(formData: FormData): Promise<void> {
  const factorId = String(formData.get("factorId") ?? "");
  if (!factorId) {
    redirect("/account/mfa?error=Missing+factor+id.");
  }
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.mfa.unenroll({ factorId });
  if (error) {
    redirect(`/account/mfa?error=${encodeURIComponent(error.message)}`);
  }
  const { data: u } = await supabase.auth.getUser();
  console.log(JSON.stringify({ event: "mfa.unenroll", userId: u.user?.id, factorId, at: new Date().toISOString() }));
  revalidatePath("/account/mfa");
  redirect("/account/mfa?ok=Removed");
}

/**
 * Generate a fresh batch of recovery codes for the signed-in user. Burns
 * any previously-unused codes. Returns the plaintext codes — the caller
 * must display them once (the DB only stores hashes).
 *
 * Requires the user to be at AAL2 (i.e. they already proved MFA in this
 * session) so an attacker who steals an AAL1 session can't issue new
 * codes and lock the legitimate user out.
 */
export async function generateRecoveryCodesAction(): Promise<
  { ok: true; codes: string[] } | { ok: false; error: string }
> {
  const supabase = await createSupabaseServerClient();
  const { data: u } = await supabase.auth.getUser();
  if (!u.user) return { ok: false, error: "Not signed in." };

  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal?.currentLevel !== "aal2") {
    return {
      ok: false,
      error: "Step up to AAL2 first — verify your authenticator before generating codes.",
    };
  }

  const codes = await generateRecoveryCodes(u.user.id);
  console.log(JSON.stringify({ event: "mfa.recovery_codes_generated", userId: u.user.id, count: codes.length, at: new Date().toISOString() }));
  revalidatePath("/account/mfa");
  return { ok: true, codes };
}
