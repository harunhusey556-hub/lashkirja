/**
 * Hand-off of files picked straight from the Lisää sheet to the screen that
 * processes them (SHELL-02 / OWN-04 camera, SHELL-30 statement import).
 *
 * The sheet row is the user gesture, so it opens the camera or the document
 * picker itself; the receiving screen must not ask again (QUALITY-BAR A1).
 *
 * Producer (AppShell, Wave A):
 *   const picked = await captureWithCamera();
 *   if (picked.kind === "files") {
 *     stashPendingCapture("receipt", picked.files);
 *     router.push(PENDING_CAPTURE_ROUTES.receipt); // "/kuitit/uusi?from=camera"
 *   }
 *
 * Consumers (books lane):
 *   - ReceiptEditor on /kuitit/uusi?from=camera, once on mount:
 *       const files = takePendingCapture("receipt");
 *       if (files) handleFilesPicked(files); // skip the picker card
 *     With `from=camera` but nothing stashed (deep link, reload, expired),
 *     show the normal picker card.
 *   - Tapahtumat on /pankki/tapahtumat?import=1, once on mount:
 *       const files = takePendingCapture("statement");
 *       if (files) void handleUpload(files[0]);
 *
 * Memory only (File objects), one-shot: `take` drains the stash, and a stash
 * older than two minutes is dropped, so a stale photo can never attach
 * itself to a later, unrelated visit.
 */

export type PendingCaptureKind = "receipt" | "statement";

export const PENDING_CAPTURE_ROUTES: Record<PendingCaptureKind, string> = {
  receipt: "/kuitit/uusi?from=camera",
  statement: "/pankki/tapahtumat?import=1",
};

/** Query flags the consumers look for. */
export const PENDING_CAPTURE_PARAMS = {
  receipt: { name: "from", value: "camera" },
  statement: { name: "import", value: "1" },
} as const satisfies Record<PendingCaptureKind, { name: string; value: string }>;

/** File types the Lisää sheet offers for a bank statement. */
export const STATEMENT_FILE_TYPES = [
  "application/pdf",
  "text/xml",
  "application/xml",
  "text/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];

/** The same set as an <input accept> string (web fallback). */
export const STATEMENT_ACCEPT = ".csv,.xlsx,.xls,.xml,.pdf,.camt,.053," + STATEMENT_FILE_TYPES.join(",");

const MAX_AGE_MS = 2 * 60 * 1000;

type Entry = { files: File[]; at: number };

const stash = new Map<PendingCaptureKind, Entry>();

export function stashPendingCapture(kind: PendingCaptureKind, files: File[], now = Date.now()): void {
  if (files.length === 0) {
    stash.delete(kind);
    return;
  }
  stash.set(kind, { files: [...files], at: now });
}

/** Drains the stash for `kind`: returns the files once, then null. */
export function takePendingCapture(kind: PendingCaptureKind, now = Date.now()): File[] | null {
  const entry = stash.get(kind);
  stash.delete(kind);
  if (!entry || now - entry.at > MAX_AGE_MS) return null;
  return entry.files;
}

/** True while fresh files wait for `kind` (does not drain). */
export function hasPendingCapture(kind: PendingCaptureKind, now = Date.now()): boolean {
  const entry = stash.get(kind);
  return Boolean(entry && now - entry.at <= MAX_AGE_MS);
}

export function clearPendingCapture(kind?: PendingCaptureKind): void {
  if (kind) stash.delete(kind);
  else stash.clear();
}
