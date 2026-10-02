/**
 * A smaller copy of a receipt photo for viewing in the app. Phone photos are often several
 * megabytes; over the home connection that was seconds per open. The stored original is never
 * changed (the accountant's package and downloads keep it). Null: send the original.
 */
const PREVIEWABLE = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);
const MAX_SIDE = 1600;
/** Below this the original is already quick to send. */
const MIN_BYTES = 400 * 1024;

export async function receiptPreview(
  original: Buffer,
  contentType: string
): Promise<{ body: Buffer; contentType: string } | null> {
  if (!PREVIEWABLE.has(contentType) || original.length < MIN_BYTES) return null;
  try {
    // sharp ships with Next (image optimisation); without it the original is sent.
    const sharp = (await import("sharp")).default;
    const body = await sharp(original, { failOn: "none" })
      .rotate()
      .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 80, mozjpeg: true })
      .toBuffer();
    return body.length < original.length ? { body, contentType: "image/jpeg" } : null;
  } catch {
    return null;
  }
}
