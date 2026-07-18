"use server";

import { revalidatePath } from "next/cache";
import { getAgentScope } from "@/lib/agent-scope";
import { getInvestorProfileByCode } from "@/lib/portal-investor";
import { prisma } from "@/lib/prisma";

export interface TicketResult {
  ok: boolean;
  message?: string;
  error?: string;
}

function trackingNumber(): string {
  const d = new Date();
  const ymd = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `SR${ymd}${rand}`;
}

/**
 * A sales agent raises a service request against one of THEIR investors. Writes
 * to the portal's shared public.service_requests so it appears on the portal
 * admin Tickets page + dashboard "Open Tickets" tile automatically. The
 * description is prefixed with the agent code so the request is clearly
 * attributed to the sales agent.
 */
export async function raiseTicket(formData: FormData): Promise<TicketResult> {
  const scope = await getAgentScope();
  const code = String(formData.get("code") ?? "").trim();
  const type = String(formData.get("type") ?? "GENERAL_INQUIRY").trim();
  const description = String(formData.get("description") ?? "").trim();

  if (!scope.codeSet.has(code)) return { ok: false, error: "You are not authorized for this investor." };
  if (!description) return { ok: false, error: "Please describe the request." };

  const profile = await getInvestorProfileByCode(code);
  if (!profile) return { ok: false, error: "Investor not found." };

  const taggedDescription = `[Sales agent ${scope.agentCode}] ${description}`;
  const sla = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);

  try {
    await prisma.$executeRawUnsafe(
      `INSERT INTO public.service_requests
         (id, "investorId", type, status, description, "trackingNumber", "slaDeadline", "createdAt", "updatedAt")
       VALUES (gen_random_uuid()::text, $1, $2, 'OPEN', $3, $4, $5, now(), now())`,
      profile.id,
      type,
      taggedDescription,
      trackingNumber(),
      sla,
    );
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not submit the request." };
  }

  revalidatePath(`/agent/investors/${code}`);
  return { ok: true, message: "Request submitted — the office will review it." };
}
