export type UploadQueueStatus =
  | "pending"
  | "uploading"
  | "processing"
  | "ready"
  | "failed"
  | "cancelled"
  | "background";

export interface UploadQueueItem {
  localId: string;
  name: string;
  status: UploadQueueStatus;
  error?: string;
  duplicateReceiptId?: string;
}

export function cancelPendingWork<T extends UploadQueueItem>(items: T[]): T[] {
  return items.map((item) =>
    item.status === "pending" ||
    item.status === "uploading" ||
    item.status === "processing" ||
    item.status === "background"
      ? { ...item, status: "cancelled" as const, error: undefined }
      : item
  );
}

export function retryFailedOnly<T extends UploadQueueItem>(items: T[]): T[] {
  return items.map((item) =>
    item.status === "failed"
      ? { ...item, status: "pending" as const, error: undefined, duplicateReceiptId: undefined }
      : item
  );
}

export function batchOutcomeMessage(
  verb: "Hyväksyttiin" | "Poistettiin",
  succeeded: number,
  failed: number
): string {
  return `${verb} ${succeeded}, epäonnistui ${failed}.`;
}
