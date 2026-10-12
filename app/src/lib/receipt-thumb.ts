/** Edge of the round list thumbnail in CSS px (the ListRow leading tile is 40). */
export const RECEIPT_THUMB_PX = 40;

/**
 * The small picture of a receipt for a list row: the preview route's `?w=160`
 * copy (4x the 40 px tile for a dense screen; ETag plus a day of private
 * cache). A list never loads the full upload; the 1600 px viewer copy is
 * fetched only when the receipt is opened.
 */
export function receiptThumbUrl(id: string, width = 160): string {
  return `/api/receipts/${encodeURIComponent(id)}/file/preview?w=${width}`;
}

type ThumbFields = {
  thumbnailUrl?: string | null;
  hasThumbnail?: boolean;
  hasFile?: boolean;
  fileName?: string | null;
};

/**
 * Whether a row has a picture to show. A paged list row carries `thumbnailUrl`
 * (null when no file is stored), which decides; an older answer says so with
 * `hasThumbnail`/`hasFile`, otherwise a stored file name is the signal.
 */
export function hasReceiptThumb(receipt: ThumbFields): boolean {
  if (receipt.thumbnailUrl !== undefined) return receipt.thumbnailUrl !== null;
  return receipt.hasThumbnail ?? receipt.hasFile ?? Boolean(receipt.fileName);
}

/** Where a row's thumbnail loads from: the URL the server gave, else the same shape built here. */
export function receiptThumbSrc(receipt: ThumbFields & { id: string }): string {
  return receipt.thumbnailUrl ?? receiptThumbUrl(receipt.id);
}
