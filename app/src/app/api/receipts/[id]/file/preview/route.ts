import { NextRequest, NextResponse } from "next/server";
import * as path from "path";
import { prisma } from "@/lib/db";
import { ensureReceiptPreviewImage, readReceiptPreviewBuffer } from "@/lib/preview";
import { cachedScaledJpeg, PREVIEW_SIDES, scaledCachePath } from "@/lib/receipt-preview";
import { requireSession } from "@/lib/session";
import { inlineContentDisposition, resolveUserUploadPath, isStoredUploadKey } from "@/lib/storage";
import { noStoreJson } from "@/lib/http-security";

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

  try {
    const absolutePath = resolveUserUploadPath(session.userId!, receipt.filePath, true);
    const basePath = await ensureReceiptPreviewImage(absolutePath, mimeType);
    if (!basePath) {
      return noStoreJson({ error: "Esikatselua ei voitu luoda" }, { status: 422 });
    }
    // ?size=thumb for list rows (360 px), otherwise the viewer's 1600 px copy; both cached.
    const side = req.nextUrl.searchParams.get("size") === "thumb" ? PREVIEW_SIDES.thumb : PREVIEW_SIDES.view;
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
        "Cache-Control": "private, no-store, max-age=0",
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
