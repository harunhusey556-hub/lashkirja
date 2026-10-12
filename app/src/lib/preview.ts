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
      // pdftoppm pads the number to the page count's width: page-01.jpg for a 10+ page PDF.
      .find((name) => /^page-0*1\.jpg$/i.test(name));
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

  if (mimeType === "text/html" || /\.html?$/i.test(absolutePath)) {
    // Generate a simple SVG placeholder for HTML receipts
    const svg = `
      <svg width="600" height="800" xmlns="http://www.w3.org/2000/svg">
        <rect width="100%" height="100%" fill="#f8fafc"/>
        <g transform="translate(300, 400)" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif">
          <path d="M-40,-30 L40,-30 C45.5,-30 50,-25.5 50,-20 L50,20 C50,25.5 45.5,30 40,30 L-40,30 C-45.5,30 -50,25.5 -50,20 L-50,-20 C-50,-25.5 -45.5,-30 -40,-30 Z" fill="none" stroke="#94a3b8" stroke-width="4"/>
          <path d="M-50,-20 L0,10 L50,-20" fill="none" stroke="#94a3b8" stroke-width="4"/>
          <text y="70" fill="#64748b" font-size="24" font-weight="500">Sähköpostikuitti</text>
        </g>
      </svg>
    `;
    const svgPath = `${absolutePath}.preview.svg`;
    fs.writeFileSync(svgPath, Buffer.from(svg.trim()), { mode: 0o600 });
    return svgPath;
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
    previewPath.endsWith(".svg")
      ? "image/svg+xml"
      : previewPath === absolutePath
      ? mimeType.startsWith("image/") ? mimeType : "image/jpeg"
      : "image/jpeg";
  return { buffer, contentType: contentType === "image/png" ? "image/png" : contentType };
}

export function needsGeneratedPreview(mimeType: string, fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return (
    isPdf(mimeType, lower) ||
    isHeic(mimeType, lower) ||
    mimeType === "text/html" ||
    /\.pdf$/i.test(lower) ||
    /\.(heic|heif|html?)$/i.test(lower)
  );
}
