// Print assets embedded as data URIs.
//
// Ported from the portal's lib/pdf-assets.ts. The agent's purchase form and
// order confirmation are replicas of the portal's, and the portal draws Ekush's
// authorised signature on both — a client-facing document that prints without
// it looks unsigned next to the one the portal issues for the same order.
//
// Data URIs rather than /public URLs: the browser's print path does not always
// fetch late-loading images, and the portal settled on embedding for exactly
// that reason. The files are small (~6 KB) and cached after first read.

import fs from "fs";
import path from "path";

function loadPublicPngAsDataUrl(filename: string): string | null {
  try {
    const abs = path.join(process.cwd(), "public", filename);
    return `data:image/png;base64,${fs.readFileSync(abs).toString("base64")}`;
  } catch {
    // Missing asset is not fatal — callers fall back to a blank cell, as the
    // portal's own null path does.
    return null;
  }
}

let signatureCache: string | null | undefined;
/** Ekush's authorised signature (public/authorized-signature.png). */
export function getAuthorizedSignatureDataUrl(): string | null {
  if (signatureCache !== undefined) return signatureCache;
  signatureCache = loadPublicPngAsDataUrl("authorized-signature.png");
  return signatureCache;
}

let logoCache: string | null | undefined;
/** The letterhead logo the portal's printed forms use (public/logo.png). */
export function getLogoDataUrl(): string | null {
  if (logoCache !== undefined) return logoCache;
  logoCache = loadPublicPngAsDataUrl("logo.png");
  return logoCache;
}
