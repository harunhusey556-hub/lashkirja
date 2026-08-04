import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { inlineContentDisposition, readUserUpload } from "@/lib/storage";
import { noStoreJson } from "@/lib/http-security";

/** Authenticated preview for an unclaimed, tenant-owned staged upload. */
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
    const buffer = await readUserUpload(session.userId!, upload.storageKey);
    return new NextResponse(buffer, {
      headers: {
        "Content-Type": upload.mimeType,
        "Content-Length": String(buffer.length),
        "Cache-Control": "private, no-store, max-age=0",
        "Content-Disposition": inlineContentDisposition(upload.originalName),
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("Staged upload read failed:", error);
    }
    return noStoreJson({ error: "Tiedostoa ei löytynyt" }, { status: 404 });
  }
}
