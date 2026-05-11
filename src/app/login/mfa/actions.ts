"use server";

import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const SAFE_NEXT = /^\/(?!\/)[A-Za-z0-9_\-./?=&]*$/;

function safeRedirect(next: string, fallback: string): string {
  return SAFE_NEXT.test(next) ? next : fallback;
}

/**
 * Server-side TOTP verification used by both /login/mfa (staff) and
 * /agent/login/mfa (selling agents). Picks the user's first verified
 * factor, challenges it, and verifies the user-entered code.
 *
 * On success: redirects to `next` (validated) — by this point the session
 * is AAL2 so the subsequent page guard passes.
 */
export async function verifyChallenge(formData: FormData): Promise<void> {
  const code = String(formData.get("code") ?? "").trim();
  const next = String(formData.get("next") ?? "");
  const portal = String(formData.get("portal") ?? "staff") as "staff" | "agent";

  const errorReturn = portal === "agent" ? "/agent/login/mfa" : "/login/mfa";
  const successFallback = portal === "agent" ? "/agent" : "/dashboard";

  if (!/^\d{6}$/.test(code)) {
    redirect(`${errorReturn}?error=Enter+the+6-digit+code+from+your+authenticator.${next ? `&next=${encodeURIComponent(next)}` : ""}`);
  }

  const supabase = await createSupabaseServerClient();
  const { data: factorsData, error: factorsErr } = await supabase.auth.mfa.listFactors();
  if (factorsErr || !factorsData) {
    redirect(`${errorReturn}?error=Could+not+load+your+factors.`);
  }
  const verified = factorsData!.all.filter((f) => f.status === "verified");
  if (verified.length === 0) {
    // No verified factor — user shouldn't be here. Bounce to enrolment.
    redirect("/account/mfa?reason=required");
  }
  const factorId = verified[0].id;

  const { data: challengeData, error: challengeErr } = await supabase.auth.mfa.challenge({
    factorId,
  });
  if (challengeErr || !challengeData) {
    redirect(`${errorReturn}?error=Could+not+start+verification.+Try+again.`);
  }

  const { error: verifyErr } = await supabase.auth.mfa.verify({
    factorId,
    challengeId: challengeData!.id,
    code,
  });
  if (verifyErr) {
    const { data: u } = await supabase.auth.getUser();
    console.warn(JSON.stringify({ event: "mfa.verify_fail", phase: "challenge", portal, userId: u.user?.id, factorId, at: new Date().toISOString() }));
    redirect(`${errorReturn}?error=That+code+did+not+match.${next ? `&next=${encodeURIComponent(next)}` : ""}`);
  }

  redirect(safeRedirect(next, successFallback));
}

/** Sign out from the challenge screen (escape hatch if user is stuck). */
export async function signOutFromChallenge(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect("/login");
}
