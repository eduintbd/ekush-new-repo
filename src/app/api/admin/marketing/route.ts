// POST /api/admin/marketing — admin uploads one marketing file (jpg/png/webp
// or pdf) with a title and category, for all agents to download.
//
// Reuses the hardened uploadKycFile pipeline (magic-byte sniff, size caps,
// sharp re-encode stripping EXIF). Files land in the private `kyc-documents`
// bucket under `marketing/<uuid>`; agents fetch them via short-lived signed
// URLs. Multipart, so an API route rather than a server action.

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { withActor } from "@/lib/prisma";
import { KycUploadError, uploadKycFile } from "@/lib/kyc-upload";
import { isMarketingCategory } from "@/lib/marketing-contents";

export const runtime = "nodejs";
export const maxDuration = 60;

// Marketing files are shared with clients, so a brochure PDF is normal — allow
// PDF for the single marketing "doc type".
const MARKETING_PDF_ALLOWED = new Set<string>(["marketing"]);

export async function POST(req: Request) {
  const me = await requireRole(["admin", "checker"]);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected a multipart form upload." }, { status: 400 });
  }

  const title = String(form.get("title") ?? "").trim();
  const category = String(form.get("category") ?? "general").trim();
  const file = form.get("file");

  if (!title) return NextResponse.json({ error: "A title is required." }, { status: 400 });
  if (!isMarketingCategory(category)) {
    return NextResponse.json({ error: "Unknown category." }, { status: 400 });
  }
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "Choose a file to upload." }, { status: 400 });
  }

  let uploaded;
  try {
    uploaded = await uploadKycFile(file, {
      investorId: "shared", // grouping id — marketing files aren't per-investor
      docType: "marketing",
      pathPrefix: "marketing",
      pdfAllowedKinds: MARKETING_PDF_ALLOWED,
    });
  } catch (err) {
    if (err instanceof KycUploadError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  await withActor(me.id, (tx) =>
    tx.agentMarketingContent.create({
      data: {
        title,
        category,
        fileName: uploaded.displayName,
        filePath: uploaded.filePath,
        mimeType: uploaded.storedMimeType,
        uploadedBy: me.id,
      },
    }),
  );

  return NextResponse.json({ ok: true });
}
