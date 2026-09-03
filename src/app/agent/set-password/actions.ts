"use server";

import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { redeemPasswordTicket, requestBaseUrl } from "@/lib/agent-invite";
import { validatePassword } from "@/lib/password-rules";

const PAGE = "/agent/set-password";

function backToTicket(token: string, error: string): never {
  redirect(`${PAGE}?t=${encodeURIComponent(token)}&error=${encodeURIComponent(error)}`);
}

function backToForm(error: string): never {
  redirect(`${PAGE}?stage=set&error=${encodeURIComponent(error)}`);
}

/**
 * Step 1 — the button on the emailed ticket page.
 *
 * This is a POST on purpose, and that is the whole fix: a mail gateway or a
 * chat link-preview crawler issues a GET, which renders the page and spends
 * nothing. Only a real click gets here. See src/lib/agent-invite.ts.
 *
 * On success the Supabase session is written to cookies, so step 2 runs
 * entirely server-side and nothing sensitive is handed to the browser.
 */
export async function startPasswordSetup(formData: FormData): Promise<void> {
  const token = String(formData.get("token") ?? "").trim();
  if (!token) redirect(`${PAGE}?error=${encodeURIComponent("This link is missing its token.")}`);

  const result = await redeemPasswordTicket(token, await requestBaseUrl());
  if (!result.ok) backToTicket(token, result.error);

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.setSession({
    access_token: result.accessToken,
    refresh_token: result.refreshToken,
  });
  // The ticket is spent either way — it was claimed before the session was
  // minted — so say so plainly rather than inviting a retry that cannot work.
  if (error) {
    redirect(
      `${PAGE}?error=${encodeURIComponent(
        `Could not open a password session (${error.message}). Ask for a fresh link.`,
      )}`,
    );
  }

  redirect(`${PAGE}?stage=set`);
}

/**
 * Step 2 — save the password against the session established by step 1.
 *
 * Validated server-side: the old flow enforced the policy in the browser only,
 * which is advisory at best.
 */
export async function saveAgentPassword(formData: FormData): Promise<void> {
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  const check = validatePassword(password);
  if (!check.ok) backToForm(check.reason);
  if (password !== confirm) backToForm("Passwords do not match.");

  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) {
    redirect(
      `${PAGE}?error=${encodeURIComponent(
        "Your password session has ended. Request a fresh link and try again.",
      )}`,
    );
  }

  const { error } = await supabase.auth.updateUser({ password });
  if (error) backToForm(error.message);

  // Sign out so the agent starts clean with the password they just chose.
  await supabase.auth.signOut();
  redirect(`/agent/login?ok=${encodeURIComponent("Password set. Sign in with your new password.")}`);
}
