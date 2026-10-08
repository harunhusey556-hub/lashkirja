/**
 * A smaller copy of a receipt photo for viewing in the app. Phone photos are often several
 * megabytes; over the home connection that was seconds per open. The stored original is never
 * changed (the accountant's package and downloads keep it). Null: send the original.
 */
const PREVIEWABLE = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);
const MAX_SIDE = 1600;
/** Below this the original is already quick to send. */
const MIN_BYTES = 400 * 1024;
export const PREVIEW_MIN_BYTES = MIN_BYTES;

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

/** Sizes the app asks for: a list thumbnail and the viewer's copy. */
export const PREVIEW_SIDES = { thumb: 360, view: MAX_SIDE } as const;

/** The cached scaled copy beside a stored upload (deleted with it, see storage.removeUserUpload). */
export function scaledCachePath(absolutePath: string, maxSide: number): string {
  return `${absolutePath}.${maxSide}.jpg`;
}

/**
 * A JPEG of `source` no larger than `maxSide`, made once and cached beside the upload: the
 * stored file never changes, so the copy never goes stale. A phone photo of several megabytes
 * became a ~30 kB thumbnail; before this every list row downloaded the original (median 3,3 s
 * over the home connection, 2026-10-08). Null when sharp cannot read it: send the source.
 */
export async function cachedScaledJpeg(
  sourcePath: string,
  cachePath: string,
  maxSide: number
): Promise<Buffer | null> {
  const fs = await import("node:fs/promises");
  try {
    return await fs.readFile(cachePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    const sharp = (await import("sharp")).default;
    // Bytes, not the path: given a path, sharp keeps the file open on Windows and the upload
    // could no longer be deleted (EBUSY) — production runs on Windows.
    const input = await fs.readFile(sourcePath);
    const body = await sharp(input, { failOn: "none" })
      .rotate()
      .resize({ width: maxSide, height: maxSide, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: maxSide <= PREVIEW_SIDES.thumb ? 72 : 80, mozjpeg: true })
      .toBuffer();
    // Written beside the original with the same owner-only mode; a failed write only costs the cache.
    await fs.writeFile(cachePath, body, { mode: 0o600 }).catch((error: unknown) =>
      console.warn("Preview cache write failed:", cachePath, error)
    );
    return body;
  } catch (error) {
    console.warn("Scaled preview failed:", sourcePath, error);
    return null;
  }
}
