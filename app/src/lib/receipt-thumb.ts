/** Edge of the round list thumbnail in CSS px (the ListRow leading tile is 40). */
export const RECEIPT_THUMB_PX = 40;

/**
 * The small picture of a receipt for a list row. `size=thumb` is the preview
 * route's existing cached 360 px copy; `w=160` asks the server for a copy sized
 * to the tile (4x for a dense screen) and is ignored by a server that predates
 * it. A list never loads the full upload; the 1600 px viewer copy is fetched
 * only when the receipt is opened.
 */
export function receiptThumbUrl(id: string, width = 160): string {
  return `/api/receipts/${encodeURIComponent(id)}/file/preview?size=thumb&w=${width}`;
}

/**
 * Whether a row has a picture to show. The list answer says so when it can
 * (`hasThumbnail`, `hasFile`); otherwise a stored file name is the signal.
 */
export function hasReceiptThumb(receipt: { hasThumbnail?: boolean; hasFile?: boolean; fileName?: string | null }): boolean {
  return receipt.hasThumbnail ?? receipt.hasFile ?? Boolean(receipt.fileName);
}
