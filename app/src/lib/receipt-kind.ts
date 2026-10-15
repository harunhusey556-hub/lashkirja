import { prisma } from "@/lib/db";
import { AppError, NotFoundError } from "@/lib/api-errors";
import {
  deletePurchaseInvoice,
  syncReceiptDocumentKind,
  type ReceiptFilingSkip,
} from "@/lib/purchase-invoices";

export type ReceiptKind = "receipt" | "invoice";

export interface ReceiptKindResult {
  kind: ReceiptKind;
  purchaseInvoiceAction: "filed" | "reopened" | "removed" | "none";
  /** Why no ostolasku was filed for "invoice" (no supplier, a duplicate...); null otherwise. */
  purchaseInvoiceSkipped: ReceiptFilingSkip | null;
  /** The ostolasku the receipt is filed as after the change; null for a kuitti. */
  purchaseInvoice: { id: string; dueDate: string; isCreditNote: boolean } | null;
}

/**
 * The owner corrects the AI's kuitti / ostolasku decision right after an upload
 * (POST /api/receipts/[id]/kind). Unlike the receipt screen's PATCH, which
 * cancels and keeps the ostolasku, a wrong decision made a moment ago is undone
 * outright: "receipt" removes the ostolasku filed from this receipt, so
 * Ostolaskut is not left with a cancelled row the owner never wanted. Anything
 * that is already bookkeeping - a payment, a credit note, a closed month, a
 * settled invoice - refuses with a 409.
 *
 * Idempotent: asking for the kind the receipt already is changes nothing.
 */
export async function setReceiptKind(
  userId: string,
  receiptId: string,
  kind: ReceiptKind
): Promise<ReceiptKindResult> {
  const receipt = await prisma.receipt.findFirst({
    where: { id: receiptId, userId },
    select: {
      uploadId: true,
      upload: { select: { extractedJson: true } },
      purchaseInvoice: { select: { id: true, status: true } },
    },
  });
  if (!receipt) throw new NotFoundError("Kuittia ei löytynyt.");
  // A cancelled ostolasku owes nothing: the receipt is a kuitti already.
  const live = receipt.purchaseInvoice && receipt.purchaseInvoice.status !== "cancelled"
    ? receipt.purchaseInvoice
    : null;

  let action: ReceiptKindResult["purchaseInvoiceAction"] = "none";
  let skipped: ReceiptFilingSkip | null = null;
  if (kind === "receipt") {
    if (live) {
      if (live.status !== "open") {
        throw new AppError(
          "Ostolasku on jo maksettu tai hyvitetty, joten sitä ei voi muuttaa kuitiksi.",
          "INVOICE_SETTLED",
          409
        );
      }
      // Payments, credit notes and a closed month are deletePurchaseInvoice's own 409s.
      await deletePurchaseInvoice(userId, live.id);
      action = "removed";
    }
  } else if (!live) {
    // Filing (fileReceiptAsPurchaseInvoice, idempotent per receipt) or reopening the
    // ostolasku the owner once marked a kuitti; the period lock is checked there.
    const synced = await syncReceiptDocumentKind(userId, receiptId, "invoice");
    action = synced.action === "filed" || synced.action === "reopened" ? synced.action : "none";
    skipped = synced.skipped ?? null;
  }

  // Recorded only once the change went through, so a refused change leaves the reading as it was.
  if (receipt.uploadId) await recordOwnerKind(userId, receipt.uploadId, receipt.upload?.extractedJson ?? null, kind);

  const filed = await prisma.purchaseInvoice.findFirst({
    where: { userId, receiptId, status: { not: "cancelled" } },
    select: { id: true, dueDate: true, grossCents: true },
  });
  return {
    kind,
    purchaseInvoiceAction: action,
    purchaseInvoiceSkipped: skipped,
    purchaseInvoice: filed
      ? { id: filed.id, dueDate: filed.dueDate.toISOString().slice(0, 10), isCreditNote: filed.grossCents < 0 }
      : null,
  };
}

/**
 * The owner's word replaces the AI's in the upload's stored reading. An edit's
 * automatic filing (syncReceiptDocumentKind with no kind) goes by that reading,
 * so without this a removed ostolasku would come back on the next edit; "Lue
 * uudelleen" never writes the stored reading, so it keeps the owner's kind too.
 */
async function recordOwnerKind(
  userId: string,
  uploadId: string,
  extractedJson: string | null,
  kind: ReceiptKind
): Promise<void> {
  let reading: Record<string, unknown> = {};
  if (extractedJson) {
    try {
      const parsed: unknown = JSON.parse(extractedJson);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) reading = parsed as Record<string, unknown>;
    } catch (error) {
      // The ostolasku itself is already right; only a later edit could misfile it.
      console.warn(`Stored reading of upload ${uploadId} does not parse; owner's kind not recorded:`, error);
      return;
    }
  }
  if (reading.documentType === kind && reading.documentTypeSetBy === "owner") return;
  await prisma.upload.updateMany({
    where: { id: uploadId, userId },
    data: { extractedJson: JSON.stringify({ ...reading, documentType: kind, documentTypeSetBy: "owner" }) },
  });
}
