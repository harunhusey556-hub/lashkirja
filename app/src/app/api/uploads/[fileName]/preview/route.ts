import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { readReceiptPreviewBuffer } from "@/lib/preview";
import { requireSession } from "@/lib/session";
import { inlineContentDisposition, resolveUserUploadPath } from "@/lib/storage";
import { noStoreJson } from "@/lib/http-security";

/** JPEG preview for staged uploads (PDF page 1, HEIC→JPEG). */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ fileName: string }> }
) {
  const session = await requireSession(req);
  if (!session) return noStoreJson({ error: "Ei kirjautunut" }, { status: 401 });
  const { fileName } = await params;

  const upload = await prisma.upload.findFirst({
    where: {
      storageKey: fileName,
      userId: session.userId!,
      purpose: "receipt",
      claimedAt: null,
      expiresAt: { gt: new Date() },
    },
    select: { storageKey: true, originalName: true, mimeType: true },
  });
  if (!upload) return noStoreJson({ error: "Tiedostoa ei löytynyt" }, { status: 404 });

  try {
    const absolutePath = resolveUserUploadPath(session.userId!, upload.storageKey);
    const preview = await readReceiptPreviewBuffer(absolutePath, upload.mimeType);
    if (!preview) {
      return noStoreJson({ error: "Esikatselua ei voitu luoda" }, { status: 422 });
    }
    const baseName = upload.originalName.replace(/\.[^.]+$/, "") || "kuitti";
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
    console.error("Upload preview failed:", error);
    return noStoreJson({ error: "Esikatselun luonti epäonnistui" }, { status: 500 });
  }
}
