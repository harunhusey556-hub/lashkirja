import type { ExtractedReceipt } from "./ai";

/**
 * Mail sync reads every message with a PDF or an image, which also brings in
 * newsletters, shipping notices and logos. What does not read as a bill is
 * archived (reviewStatus "rejected") instead of waiting in the review queue;
 * the owner can restore it from Sähköposti → Arkisto.
 */
export function looksLikeBill(
  extraction: Pick<ExtractedReceipt, "vendor" | "date" | "totalAmount" | "unreadable" | "confidence"> &
    Partial<Pick<ExtractedReceipt, "documentType" | "notes">>
): boolean {
  if (extraction.unreadable) return false;
  // The AI's own reading wins: a campaign mail shows prices, so an amount alone proves nothing.
  if (extraction.documentType === "marketing" || extraction.documentType === "other") return false;
  if (extraction.notes && MARKETING_NOTE.test(extraction.notes)) return false;
  if (!extraction.totalAmount) return false;
  if (extraction.confidence < 0.3 && !extraction.vendor && !extraction.date) return false;
  return true;
}

/** What the AI writes in notes when it recognises an advert instead of a bill. */
export const MARKETING_NOTE = /markkinointi|mainos|uutiskirje|kampanja|ei (ole )?(kuitti|lasku)|newsletter|advertis/i;

/** Subjects of real bills and receipts, which mailing systems send too. */
const BILL_SUBJECT = /kuitti|lasku|receipt|invoice|tilausvahvistus|order confirmation|maksuvahvistus|payment received|tosite/i;

/**
 * A mail sent through a mailing list (List-Unsubscribe) with no PDF or photo of a bill and a
 * subject that names no bill is marketing: it is not read by the AI at all.
 */
export function isMarketingMail(mail: { listUnsubscribe: boolean; hasBillAttachment: boolean; subject: string }): boolean {
  if (!mail.listUnsubscribe || mail.hasBillAttachment) return false;
  return !BILL_SUBJECT.test(mail.subject);
}

/** Images this small are logos, signatures and tracking pixels; they are not sent to the AI at all. */
const MIN_IMAGE_BYTES = 15_000;

export function isTooSmallToBeABill(mimeType: string, sizeBytes: number): boolean {
  return mimeType.toLowerCase().startsWith("image/") && sizeBytes < MIN_IMAGE_BYTES;
}

export const ARCHIVED_NOTE = "Arkistoitu automaattisesti: ei näytä laskulta tai kuitilta.";
