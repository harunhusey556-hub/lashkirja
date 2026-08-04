import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const PREVIEW_SUFFIX = ".preview.jpg";

export function previewImagePath(absolutePath: string): string {
  return `${absolutePath}${PREVIEW_SUFFIX}`;
}

function isHeic(mimeType: string, absolutePath: string): boolean {
  return /heic|heif/i.test(mimeType) || /\.(heic|heif)$/i.test(absolutePath);
}

function isPdf(mimeType: string, absolutePath: string): boolean {
  return mimeType === "application/pdf" || /\.pdf$/i.test(absolutePath);
}

function isRasterImage(mimeType: string, absolutePath: string): boolean {
  return (
    /^image\/(jpeg|png)$/i.test(mimeType) ||
    /\.(jpe?g|png)$/i.test(absolutePath)
  );
}

/** Render page 1 of a PDF to JPEG (works on mobile where PDF embed fails). */
function pdfFirstPageJpeg(pdfPath: string, outPath: string): void {
  const tempRoot = path.resolve(os.tmpdir());
  const tempDir = fs.mkdtempSync(path.join(tempRoot, "lashkirja-preview-"));
  try {
    const prefix = path.join(tempDir, "page");
    execFileSync(
      "pdftoppm",
      ["-f", "1", "-l", "1", "-r", "144", "-jpeg", "-jpegopt", "quality=85", pdfPath, prefix],
      { timeout: 30_000, stdio: ["ignore", "pipe", "ignore"] }
    );
    const page = fs
      .readdirSync(tempDir)
      .find((name) => /^page-1\.jpg$/i.test(name));
    if (!page) throw new Error("PDF preview page missing");
    fs.copyFileSync(path.join(tempDir, page), outPath);
    fs.chmodSync(outPath, 0o600);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function heicToJpeg(heicPath: string, outPath: string): Promise<void> {
  const heicConvert = (await import("heic-convert")).default;
  const outputBuffer = await heicConvert({
    buffer: fs.readFileSync(heicPath),
    format: "JPEG",
    quality: 0.88,
  });
  fs.writeFileSync(outPath, Buffer.from(outputBuffer), { mode: 0o600 });
}

/**
 * Ensure a browser-friendly JPEG preview exists beside the stored upload.
 * Returns absolute path to JPEG bytes (original for JPG/PNG, .preview.jpg otherwise).
 */
export async function ensureReceiptPreviewImage(
  absolutePath: string,
  mimeType: string
): Promise<string | null> {
  if (!fs.existsSync(absolutePath)) return null;

  if (isRasterImage(mimeType, absolutePath)) {
    return absolutePath;
  }

  const outPath = previewImagePath(absolutePath);
  if (fs.existsSync(outPath)) return outPath;

  if (isPdf(mimeType, absolutePath)) {
    pdfFirstPageJpeg(absolutePath, outPath);
    return outPath;
  }

  if (isHeic(mimeType, absolutePath)) {
    await heicToJpeg(absolutePath, outPath);
    return outPath;
  }

  return null;
}

export async function readReceiptPreviewBuffer(
  absolutePath: string,
  mimeType: string
): Promise<{ buffer: Buffer; contentType: string } | null> {
  const previewPath = await ensureReceiptPreviewImage(absolutePath, mimeType);
  if (!previewPath) return null;
  const buffer = fs.readFileSync(previewPath);
  const contentType =
    previewPath === absolutePath
      ? mimeType.startsWith("image/") ? mimeType : "image/jpeg"
      : "image/jpeg";
  return { buffer, contentType: contentType === "image/png" ? "image/png" : "image/jpeg" };
}

export function needsGeneratedPreview(mimeType: string, fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return (
    isPdf(mimeType, lower) ||
    isHeic(mimeType, lower) ||
    /\.pdf$/i.test(lower) ||
    /\.(heic|heif)$/i.test(lower)
  );
}
