import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import * as path from "path";
import { prisma } from "@/lib/db";
import { ensureReceiptPreviewImage, readReceiptPreviewBuffer } from "@/lib/preview";
import { cachedScaledJpeg, PREVIEW_SIDES, scaledCachePath, THUMB_WIDTHS } from "@/lib/receipt-preview";
import { requireSession } from "@/lib/session";
import { inlineContentDisposition, resolveUserUploadPath, isStoredUploadKey } from "@/lib/storage";
import { noStoreJson } from "@/lib/http-security";

/** Bump when the rendering changes, so every cached preview gets a new ETag. */
const PREVIEW_VERSION = 1;
/**
 * Private (never a shared cache) and fresh for a day: the bytes for a receipt never change, because
 * its file is never replaced. Revalidation after that costs one lookup and a 304.
 */
const PREVIEW_CACHE_CONTROL = "private, max-age=86400";

const MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".html": "text/html",
  ".htm": "text/html",
};

/** JPEG preview for saved receipt files (PDF page 1, HEIC→JPEG). */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await requireSession(req);
  if (!session) return noStoreJson({ error: "Ei kirjautunut" }, { status: 401 });
  const { id } = await params;

  const receipt = await prisma.receipt.findFirst({
    where: { id, userId: session.userId! },
    select: {
      filePath: true,
      fileName: true,
      upload: { select: { mimeType: true } },
    },
  });
  if (!receipt?.filePath) {
    return noStoreJson({ error: "Kuittia ei löytynyt" }, { status: 404 });
  }
  if (!isStoredUploadKey(receipt.filePath)) {
    return noStoreJson({ error: "Kuitilla ei ole tiedostoa" }, { status: 404 });
  }

  const mimeType =
    receipt.upload?.mimeType ||
    MIME[path.extname(receipt.filePath).toLowerCase()] ||
    "application/octet-stream";

  // ?w=160|320 for list rows (W24), ?size=thumb (360 px), otherwise the viewer's 1600 px copy; all cached.
  const rawWidth = req.nextUrl.searchParams.get("w");
  const width = rawWidth == null ? null : THUMB_WIDTHS.find((w) => String(w) === rawWidth);
  if (width === undefined) {
    return noStoreJson({ error: `w on ${THUMB_WIDTHS.join(" tai ")}` }, { status: 400 });
  }
  const side = width ?? (req.nextUrl.searchParams.get("size") === "thumb" ? PREVIEW_SIDES.thumb : PREVIEW_SIDES.view);
  // A stored upload never changes under its key (a new file gets a new key), so key + size names
  // the bytes: a list that reopens revalidates each thumbnail with one indexed lookup and a 304,
  // without reading the file or touching sharp.
  const etag = `"${createHash("sha1").update(`${PREVIEW_VERSION}|${receipt.filePath}|${side}`).digest("base64url")}"`;
  const sent = req.headers.get("if-none-match");
  if (sent && sent.split(",").some((tag) => tag.trim().replace(/^W\//, "") === etag)) {
    return new NextResponse(null, { status: 304, headers: { ETag: etag, "Cache-Control": PREVIEW_CACHE_CONTROL, Vary: "Cookie, Authorization" } });
  }

  try {
    const absolutePath = resolveUserUploadPath(session.userId!, receipt.filePath, true);
    const basePath = await ensureReceiptPreviewImage(absolutePath, mimeType);
    if (!basePath) {
      return noStoreJson({ error: "Esikatselua ei voitu luoda" }, { status: 422 });
    }
    const scaled = basePath.endsWith(".svg")
      ? null
      : await cachedScaledJpeg(basePath, scaledCachePath(absolutePath, side), side);
    const preview = scaled
      ? { buffer: scaled, contentType: "image/jpeg" }
      : await readReceiptPreviewBuffer(absolutePath, mimeType);
    if (!preview) {
      return noStoreJson({ error: "Esikatselua ei voitu luoda" }, { status: 422 });
    }
    const baseName = receipt.fileName.replace(/\.[^.]+$/, "") || "kuitti";
    return new NextResponse(preview.buffer as unknown as BodyInit, {
      headers: {
        "Content-Type": preview.contentType,
        "Content-Length": String(preview.buffer.length),
        "Cache-Control": PREVIEW_CACHE_CONTROL,
        ETag: etag,
        Vary: "Cookie, Authorization",
        "Content-Disposition": inlineContentDisposition(`${baseName}-preview.jpg`),
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    // A file that is gone (as in the file route) is a 404, not a server fault: the list shows
    // its placeholder instead of counting an error per row.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return noStoreJson({ error: "Tiedostoa ei löytynyt" }, { status: 404 });
    }
    console.error("Receipt preview failed:", error);
    return noStoreJson({ error: "Esikatselun luonti epäonnistui" }, { status: 500 });
  }
}
