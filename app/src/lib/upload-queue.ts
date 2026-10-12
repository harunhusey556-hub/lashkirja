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

/**
 * Runs `process` on every pending row, a bounded few at a time, until none
 * remain or `shouldStop` turns true. A plain function so the drain can be
 * unit-tested without rendering the hook (same shape as `onReconnectDebounced`).
 * `process` must mark its row non-pending before its first await -- the upload
 * lane does -- so a row is claimed exactly once and a pick of any size drains.
 */
export async function drainQueue<T extends { status: string }>(
  rows: () => T[],
  process: (row: T) => Promise<void>,
  concurrency: number,
  shouldStop: () => boolean
): Promise<void> {
  const lane = async () => {
    while (!shouldStop()) {
      const next = rows().find((row) => row.status === "pending");
      if (!next) return;
      await process(next);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, lane));
}

/** "12 / 240 valmista": ready rows out of the whole pick, counted from the rows. */
export function queueProgressCounts(items: UploadQueueItem[]): { done: number; total: number } {
  return { done: items.filter((item) => item.status === "ready").length, total: items.length };
}

export function queueProgressLabel(items: UploadQueueItem[]): string {
  const { done, total } = queueProgressCounts(items);
  return `${done} / ${total} valmista`;
}
