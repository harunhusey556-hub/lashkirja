import type { ExtractedReceipt } from "./ai";

/**
 * Mail sync reads every message with a PDF or an image, which also brings in
 * newsletters, shipping notices and logos. What does not read as a bill is
 * archived (reviewStatus "rejected") instead of waiting in the review queue;
 * the owner can restore it from Sähköposti → Arkisto.
 */
export function looksLikeBill(
  extraction: Pick<ExtractedReceipt, "vendor" | "date" | "totalAmount" | "unreadable" | "confidence">
): boolean {
  if (extraction.unreadable) return false;
  if (!extraction.totalAmount) return false;
  if (extraction.confidence < 0.3 && !extraction.vendor && !extraction.date) return false;
  return true;
}

/** Images this small are logos, signatures and tracking pixels; they are not sent to the AI at all. */
const MIN_IMAGE_BYTES = 15_000;

export function isTooSmallToBeABill(mimeType: string, sizeBytes: number): boolean {
  return mimeType.toLowerCase().startsWith("image/") && sizeBytes < MIN_IMAGE_BYTES;
}

export const ARCHIVED_NOTE = "Arkistoitu automaattisesti: ei näytä laskulta tai kuitilta.";
