/**
 * A photo the server could not read (no OCR on the machine, or nothing but
 * pixels) is not a failure: the receipt form opens with the file attached and
 * empty fields, and this one calm line tells the user to type them in (F04).
 * Client-safe: no server imports, so the editor and the staging code share it.
 */
export const UNREADABLE_RECEIPT_NOTE = "Kuvasta ei voitu lukea tietoja, täytä ne itse.";

/** The note older pending receipts of an unreadable photo still carry. */
const LEGACY_UNREADABLE_RECEIPT_NOTE = "Tietoja ei saatu luettua kuvasta. Täydennä käsin.";

/** True for the current note and the older one: both mean "nothing was read, type it in" (V13). */
export function isUnreadableNote(note: string | null | undefined): boolean {
  return note === UNREADABLE_RECEIPT_NOTE || note === LEGACY_UNREADABLE_RECEIPT_NOTE;
}
