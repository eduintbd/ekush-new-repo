// Client-side image shrinking. Browser-only — uses FileReader / Image /
// <canvas>, so only call it from a client component.
//
// Ported from the portal's lib/image-compress.ts, which exists for the same
// reason: phone cameras emit 3-8 MB JPEGs, and a document photo does not need
// anything like that. A ~1600px long edge at quality 0.82 lands well under
// 1 MB and is still comfortably readable for an NID or a cheque leaf.
//
// It matters less here than it did on the portal — agent uploads now go
// straight to storage one file at a time rather than through one bundled POST
// — but a smaller file still uploads faster and survives a weak link better,
// which is the whole point of the change this belongs to.
//
// PDFs and anything non-image pass through untouched. The server re-encodes
// images through sharp and magic-byte gates everything regardless, so this is
// a speed measure, never a security one.
//
// HEIC is deliberately NOT converted: it would mean pulling in heic2any, and
// the server already rejects HEIC with an explanation telling the agent to
// switch the iPhone to "Most Compatible". Worth revisiting if iPhone-shooting
// agents hit it often.

const MAX_EDGE = 1600;
const QUALITY = 0.82;

/** Images only, and only when shrinking actually helps. */
function shouldCompress(file: File): boolean {
  const type = (file.type || "").toLowerCase();
  if (!type.startsWith("image/")) return false;
  // Re-encoding a tiny image can make it bigger; skip anything already small.
  if (file.size < 300 * 1024) return false;
  return /^image\/(jpeg|jpg|png|webp)$/.test(type);
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("decode failed"));
    img.src = dataUrl;
  });
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

/**
 * Shrink an oversized photo. Returns the ORIGINAL file unchanged on any
 * failure, and whenever the result would not actually be smaller — a failed
 * optimisation must never cost the agent their document.
 */
export async function compressImage(file: File): Promise<File> {
  if (!shouldCompress(file)) return file;
  try {
    const img = await loadImage(await readAsDataUrl(file));
    const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
    // Already small enough in pixel terms — re-encoding buys nothing.
    if (scale === 1 && file.size < 1024 * 1024) return file;

    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", QUALITY),
    );
    if (!blob || blob.size >= file.size) return file;

    const renamed = file.name.replace(/\.(png|webp|jpeg|jpg)$/i, "") + ".jpg";
    return new File([blob], renamed, { type: "image/jpeg", lastModified: Date.now() });
  } catch {
    return file;
  }
}
