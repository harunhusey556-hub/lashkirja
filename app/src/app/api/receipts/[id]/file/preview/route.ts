import { NextRequest, NextResponse } from "next/server";
import * as path from "path";
import { prisma } from "@/lib/db";
import { readReceiptPreviewBuffer } from "@/lib/preview";
import { requireSession } from "@/lib/session";
import { inlineContentDisposition, resolveUserUploadPath } from "@/lib/storage";
import { noStoreJson } from "@/lib/http-security";

const MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".heic": "image/heic",
  ".heif": "image/heif",
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

  const mimeType =
    receipt.upload?.mimeType ||
    MIME[path.extname(receipt.filePath).toLowerCase()] ||
    "application/octet-stream";

  try {
    const absolutePath = resolveUserUploadPath(session.userId!, receipt.filePath, true);
    const preview = await readReceiptPreviewBuffer(absolutePath, mimeType);
    if (!preview) {
      return noStoreJson({ error: "Esikatselua ei voitu luoda" }, { status: 422 });
    }
    const baseName = receipt.fileName.replace(/\.[^.]+$/, "") || "kuitti";
    return new NextResponse(preview.buffer, {
      headers: {
        "Content-Type": preview.contentType,
        "Content-Length": String(preview.buffer.length),
        "Cache-Control": "private, no-store, max-age=0",
        "Content-Disposition": inlineContentDisposition(`${baseName}-preview.jpg`),
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    console.error("Receipt preview failed:", error);
    return noStoreJson({ error: "Esikatselun luonti epäonnistui" }, { status: 500 });
  }
}
