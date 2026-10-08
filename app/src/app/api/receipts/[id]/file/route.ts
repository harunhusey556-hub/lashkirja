import { NextRequest, NextResponse } from "next/server";
import * as path from "path";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { inlineContentDisposition, readUserUpload, isStoredUploadKey, resolveUserUploadPath } from "@/lib/storage";
import { noStoreJson } from "@/lib/http-security";
import { cachedScaledJpeg, PREVIEW_MIN_BYTES, PREVIEW_SIDES, scaledCachePath } from "@/lib/receipt-preview";

const MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".html": "text/html",
  ".htm": "text/html",
};

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
  if (!receipt?.filePath) return noStoreJson({ error: "Kuittia ei löytynyt" }, { status: 404 });
  if (!isStoredUploadKey(receipt.filePath)) return noStoreJson({ error: "Kuitilla ei ole tiedostoa" }, { status: 404 });

  try {
    const original = await readUserUpload(session.userId!, receipt.filePath, true);
    const originalType = receipt.upload?.mimeType || MIME[path.extname(receipt.filePath).toLowerCase()] || "application/octet-stream";
    // ?preview=1: the app's viewer gets a 1600 px copy of a large photo instead of the original,
    // made once and cached beside it (the same copy the preview route serves).
    let preview: { body: Buffer; contentType: string } | null = null;
    if (req.nextUrl.searchParams.get("preview") === "1" && original.length >= PREVIEW_MIN_BYTES && originalType.startsWith("image/")) {
      const absolutePath = resolveUserUploadPath(session.userId!, receipt.filePath, true);
      const body = await cachedScaledJpeg(absolutePath, scaledCachePath(absolutePath, PREVIEW_SIDES.view), PREVIEW_SIDES.view);
      preview = body && body.length < original.length ? { body, contentType: "image/jpeg" } : null;
    }
    const buffer = preview?.body ?? original;
    const contentType = preview?.contentType ?? originalType;
    return new NextResponse(buffer as unknown as BodyInit, {
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(buffer.length),
        "Cache-Control": "private, no-store, max-age=0",
        "Content-Disposition": inlineContentDisposition(receipt.fileName),
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("Receipt file read failed:", error);
    }
    return noStoreJson({ error: "Tiedostoa ei löytynyt" }, { status: 404 });
  }
}
