import { NextRequest, NextResponse } from "next/server";
import * as path from "path";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { inlineContentDisposition, readUserUpload } from "@/lib/storage";
import { noStoreJson } from "@/lib/http-security";

const MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heif",
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

  try {
    const buffer = await readUserUpload(session.userId!, receipt.filePath, true);
    const contentType = receipt.upload?.mimeType || MIME[path.extname(receipt.filePath).toLowerCase()] || "application/octet-stream";
    return new NextResponse(buffer, {
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
