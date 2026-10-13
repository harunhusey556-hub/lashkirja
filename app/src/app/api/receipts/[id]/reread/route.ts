import { NextRequest, NextResponse } from "next/server";
import { guardWrite, noStoreJson } from "@/lib/http-security";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { withErrorHandler, AppError } from "@/lib/api-errors";
import { isStoredUploadKey, resolveUserUploadPath } from "@/lib/storage";
import { extractReceipt } from "@/lib/ai";
import { getTopVendorsForAiPrompt } from "@/lib/vendor-intelligence";
import { isoDateToUtc } from "@/lib/validation";

/**
 * Read a stored receipt again from its own file.
 *
 * The owner's request (2026-10-13): when a bill was read wrongly - or not read at all, as
 * Kymenlaakson Sähkö's electricity bills, whose text layer extracts nothing - there was no way
 * to ask the app to try again, so the only route was typing every field by hand. This runs the
 * same extraction the upload runs, with the same profile and vendor priors, and returns the
 * fresh reading.
 *
 * It deliberately does NOT save: the reading lands in the form and the owner saves it, so an
 * already approved receipt is never overwritten behind his back.
 */
export const POST = withErrorHandler(
  async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const blocked = guardWrite(req);
    if (blocked) return blocked;
    const session = await requireSession(req);
    if (!session) {
      return NextResponse.json({ error: "Ei kirjautunut" }, { status: 401 });
    }

    const { id } = await params;
    if (!id) throw new AppError("Kuittia ei löydy", "NOT_FOUND", 404);

    const receipt = await prisma.receipt.findFirst({
      where: { id, userId: session.userId },
      include: { upload: true },
    });
    if (!receipt) throw new AppError("Kuittia ei löydy", "NOT_FOUND", 404);
    if (!receipt.filePath || !isStoredUploadKey(receipt.filePath)) {
      throw new AppError(
        "Kuitilla ei ole tiedostoa, jota voisi lukea uudelleen",
        "NO_FILE",
        422
      );
    }

    // The stored mime is only a hint: extractReceipt sniffs the file's own header.
    const mimeType = receipt.upload?.mimeType || "application/octet-stream";
    const absolutePath = resolveUserUploadPath(session.userId!, receipt.filePath, true);

    const { parseBusinessDetails, generateProfileSummary } = await import("@/lib/onboarding");
    const user = await prisma.user.findUnique({
      where: { id: session.userId! },
      select: { businessDetails: true },
    });
    const profileContext = user?.businessDetails
      ? generateProfileSummary(parseBusinessDetails(user.businessDetails))
      : undefined;
    const vendorPriors = await getTopVendorsForAiPrompt(session.userId!);

    const reading = await extractReceipt(absolutePath, mimeType, profileContext, vendorPriors);

    if (reading.unreadable) {
      return noStoreJson({ saved: false, reason: "unreadable", reading });
    }

    // A pending receipt takes the fresh reading: that is the whole point of asking again. An
    // approved one is already in the books, so its values are returned for review but nothing
    // is written - what goes into the books stays the owner's decision.
    if (receipt.reviewStatus === "approved") {
      return noStoreJson({ saved: false, reason: "approved", reading });
    }

    await prisma.receipt.update({
      where: { id: receipt.id },
      data: {
        vendor: reading.vendor,
        date: reading.date ? isoDateToUtc(reading.date) : null,
        totalAmountCents:
          reading.totalAmount == null ? null : Math.round(reading.totalAmount * 100),
        vatDetails: reading.vatDetails?.length ? JSON.stringify(reading.vatDetails) : null,
        category: reading.category,
        notes: reading.notes,
        reference: reading.reference,
        invoiceNumber: reading.invoiceNumber,
        confidence: reading.confidence,
        rawText: reading.rawText ?? null,
        source: reading.source,
      },
    });

    return noStoreJson({ saved: true, reading });
  }
);
