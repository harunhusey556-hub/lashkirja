/**
 * A photo the server could not read (no OCR on the machine, or nothing but
 * pixels) is not a failure: the receipt form opens with the file attached and
 * empty fields, and this one calm line tells the user to type them in (F04).
 * Client-safe: no server imports, so the editor and the staging code share it.
 */
export const UNREADABLE_RECEIPT_NOTE = "Kuvasta ei voitu lukea tietoja, täytä ne itse.";
