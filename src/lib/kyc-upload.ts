// Hardened KYC upload — ported from the portal's lib/upload.ts so agent-created
// registrations get the SAME protection as admin-created ones: filename
// denylist, magic-byte type gate, type-aware size caps, PDF allowlist, and a
// sharp re-encode that strips EXIF/GPS and kills polyglot payloads. Files land
// in the shared private `kyc-documents` bucket under `kyc/<investorId>/<uuid>`,
// exactly as the portal stores them (so its admin viewer serves them unchanged).

import sharp from "sharp";
import { randomUUID } from "crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_PDF_BYTES = 10 * 1024 * 1024; // 10 MB
const BUCKET = "kyc-documents";

const FORBIDDEN_EXT_TOKENS: readonly string[] = [
  ".exe", ".bat", ".cmd", ".sh", ".ps1", ".js", ".vbs", ".jar",
  ".apk", ".msi", ".scr", ".com", ".php", ".jsp", ".asp", ".aspx",
  ".py", ".rb", ".pl", ".html", ".htm", ".svg", ".dll", ".sys",
];

// PDF only legitimate on these KYC kinds (E-TIN, BO ack, NID scans, cheque).
export const PDF_ALLOWED_KYC_KINDS: ReadonlySet<string> = new Set([
  "TIN_CERT", "BO_ACKNOWLEDGEMENT",
  "NID_FRONT", "NID_BACK",
  "JOINT_NID_FRONT", "JOINT_NID_BACK",
  "NOMINEE_NID_FRONT", "NOMINEE_NID_BACK",
  "CHEQUE_LEAF_PHOTO",
]);

export class KycUploadError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function detectMagicBytes(
  buf: Buffer,
): "image/jpeg" | "image/png" | "image/webp" | "application/pdf" | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) return "image/png";
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) return "image/webp";
  if (
    buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46 &&
    buf[4] === 0x2d
  ) return "application/pdf";
  return null;
}

export interface KycUploadResult {
  filePath: string; // storage key
  storedMimeType: string;
  displayName: string;
}

/**
 * Validate + harden + store one KYC file. Throws KycUploadError on rejection.
 */
export async function uploadKycFile(
  file: File,
  opts: {
    /** Owner the file is filed under — an investor id, or an agent id when pathPrefix is "agents". */
    investorId: string;
    docType: string;
    /** Storage folder. Defaults to "kyc" (investor KYC); selling-agent profile docs pass "agents". */
    pathPrefix?: string;
    /** Which docTypes may legitimately be a PDF. Defaults to the investor KYC set. */
    pdfAllowedKinds?: ReadonlySet<string>;
  },
): Promise<KycUploadResult> {
  const buffer = Buffer.from(await file.arrayBuffer());
  if (buffer.length === 0) throw new KycUploadError(400, "File is empty.");

  const rawName = file.name ?? "";
  const lowerName = rawName.toLowerCase();
  for (const banned of FORBIDDEN_EXT_TOKENS) {
    if (lowerName.includes(banned)) {
      throw new KycUploadError(415, `Filenames containing "${banned}" are not allowed.`);
    }
  }

  const detected = detectMagicBytes(buffer.subarray(0, 12));
  if (!detected) {
    throw new KycUploadError(415, "Unsupported file type. Upload a JPEG / PNG / WEBP image, or a PDF for e-TIN / BO acknowledgement / NID / cheque.");
  }
  const isPdf = detected === "application/pdf";

  const cap = isPdf ? MAX_PDF_BYTES : MAX_IMAGE_BYTES;
  if (buffer.length > cap) {
    throw new KycUploadError(413, `File is too large (${(buffer.length / 1024 / 1024).toFixed(1)} MB). Max ${cap / 1024 / 1024} MB.`);
  }

  const pdfAllowed = opts.pdfAllowedKinds ?? PDF_ALLOWED_KYC_KINDS;
  if (isPdf && !pdfAllowed.has(opts.docType)) {
    throw new KycUploadError(415, "PDF is not allowed for this document — upload a JPEG / PNG / WEBP image.");
  }

  let outBuffer: Buffer;
  let storedMime: string;
  let storedExt: string;
  if (isPdf) {
    outBuffer = buffer;
    storedMime = "application/pdf";
    storedExt = "pdf";
  } else {
    // Re-encode to JPEG: auto-rotate on EXIF, then strip ALL metadata (GPS/EXIF).
    outBuffer = await sharp(buffer)
      .rotate()
      .jpeg({ quality: 88, mozjpeg: true })
      .withMetadata({ exif: {} })
      .toBuffer();
    storedMime = "image/jpeg";
    storedExt = "jpg";
  }

  const key = `${opts.pathPrefix ?? "kyc"}/${opts.investorId}/${randomUUID()}.${storedExt}`;
  const admin = createSupabaseAdminClient();
  if (!admin) throw new KycUploadError(500, "Storage is not configured on this deployment.");
  const { error } = await admin.storage.from(BUCKET).upload(key, outBuffer, {
    contentType: storedMime,
    upsert: true,
  });
  if (error) throw new KycUploadError(500, `Upload failed: ${error.message}`);

  const displayName = (rawName.split(/[\\/]/).pop() ?? "document")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f<>:"|?*]/g, "")
    .slice(0, 120)
    .trim() || "document";

  return { filePath: key, storedMimeType: storedMime, displayName };
}
