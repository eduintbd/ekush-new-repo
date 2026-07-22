"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma, withActor } from "@/lib/prisma";
import { requireRole } from "@/lib/auth";

/** Remove a marketing item (admin/checker). Deletes the row and best-effort
 *  removes the stored file. */
export async function deleteMarketingContent(formData: FormData): Promise<void> {
  const me = await requireRole(["admin", "checker"]);
  const id = String(formData.get("id") ?? "").trim();
  if (!id) redirect("/admin/marketing?error=Missing+item");

  const item = await prisma.agentMarketingContent.findUnique({ where: { id } });
  if (!item) redirect("/admin/marketing?error=Not+found");

  await withActor(me.id, (tx) => tx.agentMarketingContent.delete({ where: { id } }));

  try {
    const { createSupabaseAdminClient } = await import("@/lib/supabase/admin");
    const admin = createSupabaseAdminClient();
    if (admin) await admin.storage.from("kyc-documents").remove([item!.filePath]);
  } catch {
    // The row is gone; an orphaned object is cosmetic — never fail over it.
  }

  revalidatePath("/admin/marketing");
  redirect("/admin/marketing?ok=Removed");
}
