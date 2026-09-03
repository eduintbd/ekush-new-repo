// Transactional email for X-System. ekush-erp shares the portal's Supabase
// database, so it reuses the SMTP the portal admins already configured — the
// `public.app_settings` row keyed 'mail.smtp' — read via raw SQL (the same way
// portal-data.ts reads other public.* tables, keeping them out of the Prisma
// model graph). No SMTP env vars and no duplicate config.

import nodemailer from "nodemailer";
import { prisma } from "@/lib/prisma";

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  fromEmail: string;
  fromName: string;
}

export async function getSmtpConfig(): Promise<SmtpConfig | null> {
  // Single source of truth: the portal's Mail Settings page, stored in
  // public.app_settings 'mail.smtp' on the shared database. Changing the SMTP
  // config there automatically applies to these agent emails too — there is no
  // separate mail configuration for this app.
  const rows = await prisma
    .$queryRawUnsafe<{ value: string }[]>(
      `SELECT value FROM public.app_settings WHERE key = 'mail.smtp' LIMIT 1`,
    )
    .catch(() => [] as { value: string }[]);
  const raw = rows[0]?.value;
  if (!raw) return null;
  try {
    const cfg = JSON.parse(raw) as SmtpConfig;
    if (!cfg.host || !cfg.user || !cfg.pass) return null;
    return cfg;
  } catch {
    return null;
  }
}

export async function sendMail(opts: {
  to: string;
  subject: string;
  html: string;
  text?: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const cfg = await getSmtpConfig();
  if (!cfg) {
    return { ok: false, error: "SMTP is not configured (public.app_settings 'mail.smtp')." };
  }
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
  });
  try {
    await transport.sendMail({
      from: `"${cfg.fromName}" <${cfg.fromEmail}>`,
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Send failed" };
  }
}

// ─── Selling-agent onboarding email ──────────────────────────────
const BRAND = "#1c1917";

export function agentInviteEmail(opts: {
  fullName: string;
  code: string;
  actionUrl: string;
  loginUrl?: string;
  isReset?: boolean;
}): { subject: string; html: string; text: string } {
  const heading = opts.isReset ? "Reset your password" : `Welcome, ${opts.fullName}`;
  const intro = opts.isReset
    ? "Click below to choose a new password for your Ekush selling-agent account."
    : `Your selling-agent account has been approved. Your agent code is <strong>${opts.code}</strong>. Click below to set your password and sign in.`;
  const subject = opts.isReset
    ? "Reset your Ekush selling-agent password"
    : "Set up your Ekush selling-agent account";

  const loginLineHtml = opts.loginUrl
    ? `<p style="margin:16px 0 0;font-size:13px;line-height:1.6">After setting your password, sign in any time at <a href="${opts.loginUrl}" style="color:${BRAND};font-weight:600">${opts.loginUrl}</a></p>`
    : "";
  const loginLineText = opts.loginUrl ? `\nSign in any time at: ${opts.loginUrl}` : "";

  const html = `<!doctype html><html><body style="margin:0;background:#f5f5f4;font-family:Segoe UI,Arial,sans-serif;color:#1c1917">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 0"><tr><td align="center">
    <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e7e5e4">
      <tr><td style="background:${BRAND};padding:20px 28px">
        <div style="color:#fafaf9;font-size:18px;font-weight:600">Ekush Wealth Management</div>
        <div style="color:#a8a29e;font-size:12px">Selling Agent Portal</div>
      </td></tr>
      <tr><td style="padding:28px">
        <h1 style="margin:0 0 12px;font-size:18px">${heading}</h1>
        <p style="margin:0 0 20px;font-size:14px;line-height:1.6">${intro}</p>
        <p style="margin:0 0 8px"><a href="${opts.actionUrl}" style="display:inline-block;background:${BRAND};color:#fafaf9;text-decoration:none;padding:12px 22px;border-radius:8px;font-size:14px;font-weight:600">${opts.isReset ? "Reset password" : "Set your password"}</a></p>
        <p style="margin:16px 0 0;font-size:12px;color:#78716c">Opening the page is safe — nothing happens until you press “Continue” there. The link works once and is valid for a limited time; if it expires, use “Forgot password” on the sign-in page.</p>
        ${loginLineHtml}
      </td></tr>
    </table>
  </td></tr></table></body></html>`;

  const text = `${heading}\n\n${opts.isReset ? "Reset your password" : `Your selling-agent account (code ${opts.code}) has been approved.`}\nSet your password: ${opts.actionUrl}\nOpening the page is safe — nothing happens until you press "Continue" there.\nIf the link has expired, use "Forgot password" on the sign-in page.${loginLineText}`;

  return { subject, html, text };
}
