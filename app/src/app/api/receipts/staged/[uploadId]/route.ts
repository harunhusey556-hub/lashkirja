import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { noStoreJson, rejectCrossSite } from "@/lib/http-security";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import { discardStagedUpload } from "@/lib/receipt-staging";

/**
 * "Älä tallenna" on a read file that will not become a receipt (W27: the owner was
 * asked whether to save a look-alike anyway and had no way to say no). Removes the
 * staged upload and its file. Only an unsaved upload of the caller's own: a saved
 * receipt's file goes with the receipt (DELETE /api/receipts/{id}), never here.
 */
export const DELETE = withErrorHandler(async (
  req: NextRequest,
  { params }: { params: Promise<{ uploadId: string }> }
) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError("Ei kirjautunut");
  const crossSite = rejectCrossSite(req);
  if (crossSite) return crossSite;

  const { uploadId } = await params;
  const upload = await prisma.upload.findFirst({
    where: { id: uploadId, userId: session.userId!, purpose: "receipt", claimedAt: null },
    select: { id: true, storageKey: true },
  });
  if (!upload) return noStoreJson({ error: "Tiedostoa ei löytynyt" }, { status: 404 });
  await discardStagedUpload(session.userId!, upload);
  return noStoreJson({ ok: true });
});
