"use client";

import { useLayoutEffect, useRef, useState } from "react";
import {
  ApiError,
  apiFetch,
  errorMessage,
  isUnauthorized,
  readJson,
  redirectToLogin,
} from "@/components/clientFetch";
import { RECEIPT_PHASE } from "@/lib/screen-state";
import {
  cancelPendingWork,
  drainQueue,
  retryFailedOnly,
  type UploadQueueStatus,
} from "@/lib/upload-queue";
import { AUTO_SAVE_CONCURRENCY, createLimiter, takesAutoSavePath } from "@/lib/auto-accept";
import { bulkSavePayload } from "@/lib/review-queue";

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
/**
 * How many files are on the wire at once. One pick may hold hundreds of files
 * (native ReceiptUploadQueue.maxPick); the phone uploads a bounded few at a
 * time so the server is not hammered and the screen stays responsive. This is
 * NOT the pick size -- the queue drains whatever a pick holds, a few at a time.
 */
const UPLOAD_CONCURRENCY = 10;

export interface ExtractedUpload {
  source?: string;
  confidence?: number | null;
  rawText?: string | null;
  vendor?: string | null;
  date?: string | null;
  totalAmount?: number | null;
  category?: string | null;
  notes?: string | null;
  type?: string | null;
  vatDetails?: { rate?: number; amount?: number }[];
  reference?: string | null;
  invoiceNumber?: string | null;
  currency?: string | null;
  sellerCountry?: string | null;
  /** The total the document printed in `currency`, when it was not in euros. */
  originalAmount?: number | null;
  fieldConfidence?: { vendor?: number; date?: number; totalAmount?: number } | null;
  /** Nothing could be read from the file: the form opens empty for manual entry (F04). */
  unreadable?: boolean;
  /** receipt / invoice / marketing / other, when the reading names it. */
  documentType?: string | null;
}

export interface ReadyUpload {
  uploadId: string;
  filePath: string;
  originalName: string;
  extracted: ExtractedUpload;
}

export interface ReceiptQueueRow {
  localId: string;
  name: string;
  status: UploadQueueStatus;
  error?: string;
  duplicateReceiptId?: string;
  progress?: string;
  /** Present once the file is read; the auto-save sends this reading. */
  ready?: ReadyUpload;
  /** Once saved: approved automatically, or waiting in the review queue. */
  outcome?: "approved" | "pending";
  receiptId?: string;
}

/** What one auto-saved file became (W8). */
export interface AutoSavedUpload {
  receiptId: string;
  outcome: "approved" | "pending";
  /** The server saw the same vendor, date and sum already: saved for review. */
  duplicate: boolean;
}

export interface AutoSaveOptions {
  /** Off where the form itself must save (editing, linking to one bank row). */
  enabled: boolean;
  /** A single-file pick that was saved without the form. */
  onSingleSaved?: (saved: AutoSavedUpload) => void;
}

interface InternalRow extends ReceiptQueueRow {
  file: File;
  jobId?: string;
  ready?: ReadyUpload;
  /**
   * The public row handed to the list, one per internal row: recomputed only
   * when this row changes, so a memoized list row keeps its identity (and
   * does not repaint) until its own state actually moves.
   */
  listed: ReceiptQueueRow;
}

/** The row without the file bytes and the job bookkeeping. */
function listedRow(row: InternalRow): ReceiptQueueRow {
  return {
    localId: row.localId,
    name: row.name,
    status: row.status,
    error: row.error,
    duplicateReceiptId: row.duplicateReceiptId,
    progress: row.progress,
    // The reading travels with the row (W2) -- still identity-stable per row.
    ready: row.ready,
    outcome: row.outcome,
    receiptId: row.receiptId,
  };
}

export function validateUploadFile(file: File): string | null {
  if (file.size === 0) return "Tiedosto on tyhjä";
  if (file.size > MAX_UPLOAD_BYTES) return "Tiedosto on liian suuri (enintään 15 Mt)";
  const name = file.name.toLowerCase();
  const okExt = /\.(pdf|jpe?g|png|heic|heif)$/.test(name);
  const okMime = file.type === "application/pdf" || file.type.startsWith("image/");
  if (!okExt && !okMime) return "Tuemme PDF-, JPG-, PNG- ja HEIC-tiedostoja";
  return null;
}

/**
 * A picked file becomes one queue row; an invalid file keeps its message and
 * fails immediately instead of being dropped, so a migration-size pick loses
 * nothing (W1). Pure so a test can prove it without rendering the hook.
 */
export function rowFromFile(file: File, localId: string): InternalRow {
  const invalid = validateUploadFile(file);
  const listed: ReceiptQueueRow = {
    localId,
    name: file.name || "kuitti",
    status: invalid ? "failed" : "pending",
    error: invalid ?? undefined,
  };
  return { ...listed, file, listed };
}

function duplicateReceiptId(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.status !== 409 || !error.details) return null;
  if (typeof error.details !== "object" || error.details === null) return null;
  const id = (error.details as { receiptId?: unknown }).receiptId;
  return typeof id === "string" && id ? id : null;
}

function isDuplicateRefusal(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    typeof error.details === "object" &&
    error.details !== null &&
    (error.details as { isDuplicate?: unknown }).isDuplicate === true
  );
}

/**
 * Saves one read file as a receipt and lets the server approve it when the
 * reading is complete (`autoApprove`, lib/auto-accept.ts). A look-alike of a
 * receipt already on file is saved anyway, as pending, so the owner decides
 * in the review queue instead of the file silently vanishing.
 */
async function autoSaveUpload(ready: ReadyUpload): Promise<AutoSavedUpload> {
  const payload = { ...bulkSavePayload(ready.uploadId, ready.extracted), autoApprove: true };
  const post = async (forceDuplicate: boolean) => {
    const response = await apiFetch("/api/receipts/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, forceDuplicate }),
    });
    return readJson<{ receipt?: { id?: string }; autoApproved?: boolean }>(response, "Tallennus epäonnistui");
  };
  let duplicate = false;
  let data: Awaited<ReturnType<typeof post>>;
  try {
    data = await post(false);
  } catch (error: unknown) {
    if (!isDuplicateRefusal(error)) throw error;
    duplicate = true;
    data = await post(true);
  }
  if (!data.receipt?.id) throw new ApiError("Tallennus epäonnistui", 500);
  return { receiptId: data.receipt.id, outcome: data.autoApproved ? "approved" : "pending", duplicate };
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function useReceiptUploadQueue(
  onReady: (upload: ReadyUpload) => void,
  /** Called instead of marking a row "failed" when an online attempt fails
   * with a genuine network error (not a 4xx business rejection) -- Task 10's
   * offline capture path. The caller (ReceiptEditor) enqueues the file into
   * the offline receipt queue and leaves this screen; only ever passed on
   * the mobile build. */
  onNetworkFailure?: (file: File) => void,
  /** W8: a read file is saved (and approved when complete) without the form. */
  autoSave?: AutoSaveOptions
) {
  const [rows, setRows] = useState<InternalRow[]>([]);
  const rowsRef = useRef<InternalRow[]>([]);
  // The callbacks kept on one ref, refreshed after each render.
  const callbacksRef = useRef({ onReady, onNetworkFailure, autoSave });
  // Saves are bounded separately from uploads: a 200-file pick must not open
  // ten parallel bookkeeping writes (each runs the bank matching) at once.
  const saveLimit = useRef(createLimiter(AUTO_SAVE_CONCURRENCY));
  const draining = useRef(false);
  const cancelAll = useRef(false);
  const applied = useRef(false);
  const cancelListeners = useRef(new Map<string, () => void>());
  useLayoutEffect(() => {
    callbacksRef.current = { onReady, onNetworkFailure, autoSave };
  });

  function commit(next: InternalRow[]) {
    // `cancelPendingWork`/`retryFailedOnly` copy rows without refreshing their
    // public row: a row whose public fields moved gets a fresh one, an
    // unchanged row keeps its identity so the list does not repaint it.
    const fresh = next.map((row) => {
      const listed = row.listed;
      if (
        listed.status === row.status &&
        listed.error === row.error &&
        listed.progress === row.progress &&
        listed.duplicateReceiptId === row.duplicateReceiptId &&
        listed.ready === row.ready &&
        listed.outcome === row.outcome &&
        listed.receiptId === row.receiptId
      ) {
        return row;
      }
      return { ...row, listed: listedRow(row) };
    });
    rowsRef.current = fresh;
    setRows(fresh);
  }

  function patch(localId: string, partial: Partial<InternalRow>) {
    const row = rowsRef.current.find((item) => item.localId === localId);
    if (!row) return;
    // A poll tick repeating the same progress label must not rewrite the whole
    // array (and re-render every row of a migration-size pick) for nothing.
    if ((Object.keys(partial) as (keyof InternalRow)[]).every((key) => row[key] === partial[key])) return;
    commit(
      rowsRef.current.map((item) => (item.localId === localId ? { ...item, ...partial } : item))
    );
  }

  async function pollJob(jobId: string, localId: string, signal: AbortSignal): Promise<ExtractedUpload> {
    for (let attempt = 0; attempt < 90; attempt += 1) {
      const response = await apiFetch(`/api/jobs/${jobId}`, { signal, timeoutMs: 20_000 });
      const data = await readJson<{
        job: { status: string; error?: string | null; extracted?: ExtractedUpload | null; progressLabel?: string | null };
      }>(response, "Kuitin käsittely epäonnistui");
      if (data.job.progressLabel) patch(localId, { progress: data.job.progressLabel });
      if (data.job.status === "done" && data.job.extracted) return data.job.extracted;
      if (data.job.status === "failed") {
        throw new ApiError(data.job.error || "Tiedoston käsittely epäonnistui", 422);
      }
      if (data.job.status === "cancelled") {
        throw new DOMException("Aborted", "AbortError");
      }
      await sleep(1500, signal);
    }
    throw new Error("BACKGROUND");
  }

  async function uploadOne(row: InternalRow, signal: AbortSignal): Promise<void> {
    patch(row.localId, { status: "uploading", progress: RECEIPT_PHASE.upload, error: undefined });
    const body = new FormData();
    body.append("file", row.file);
    const response = await apiFetch("/api/receipts", {
      method: "POST",
      body,
      signal,
      timeoutMs: 60_000,
    });
    const data = await readJson<{
      uploadId: string;
      filePath: string;
      originalName: string;
      status?: string;
      jobId?: string;
      extracted?: ExtractedUpload;
    }>(response, "Tiedoston käsittely epäonnistui");

    let extracted = data.extracted;
    if (!extracted) {
      if (!data.jobId) throw new ApiError("Kuitin käsittely epäonnistui", 500);
      patch(row.localId, { jobId: data.jobId, status: "processing", progress: RECEIPT_PHASE.process });
      extracted = await pollJob(data.jobId, row.localId, signal);
    }
    if (signal.aborted || cancelAll.current) {
      patch(row.localId, { status: "cancelled", progress: undefined });
      return;
    }

    const ready: ReadyUpload = {
      uploadId: data.uploadId,
      filePath: data.filePath,
      originalName: data.originalName,
      extracted,
    };
    // W8: in a pick of several files every reading is saved straight away
    // (complete ones approved, the rest pending for review); a single file is
    // saved only when complete, otherwise the form opens for it as before.
    const several = rowsRef.current.length > 1;
    if (
      takesAutoSavePath({
        enabled: Boolean(callbacksRef.current.autoSave?.enabled),
        several,
        reading: extracted,
      })
    ) {
      await saveRead(row.localId, ready, several);
      return;
    }
    patch(row.localId, {
      status: "ready",
      progress: RECEIPT_PHASE.review,
      ready,
      error: undefined,
    });
    if (!applied.current) {
      applied.current = true;
      callbacksRef.current.onReady(ready);
    }
  }

  async function saveRead(localId: string, ready: ReadyUpload, several: boolean) {
    patch(localId, { status: "saving", progress: "Tallennetaan…", ready, error: undefined });
    try {
      // Not tied to the row's abort signal: a save already sent must finish,
      // or the owner could not tell whether the receipt exists.
      const saved = await saveLimit.current(() => autoSaveUpload(ready));
      patch(localId, {
        status: "saved",
        outcome: saved.outcome,
        receiptId: saved.receiptId,
        error: undefined,
        progress:
          saved.outcome === "approved"
            ? "Hyväksytty automaattisesti"
            : saved.duplicate
              ? "Samanlainen kuitti on jo tallennettu – odottaa tarkistusta"
              : "Odottaa tarkistusta",
      });
      if (!several) callbacksRef.current.autoSave?.onSingleSaved?.(saved);
    } catch (error: unknown) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      // One refused save keeps its row, with the reason, and the rest go on.
      patch(localId, {
        status: "failed",
        progress: undefined,
        error: errorMessage(error, "Tallennus epäonnistui"),
      });
    }
  }

  /** Uploads one row and waits for its reading; several run side by side (drain). */
  async function runRow(next: InternalRow) {
    const controller = new AbortController();
    const stop = () => controller.abort();
    if (cancelAll.current) return;
    const onCancel = () => stop();
    cancelListeners.current.set(next.localId, onCancel);
    try {
      await uploadOne(next, controller.signal);
    } catch (error: unknown) {
      if (cancelAll.current || (error instanceof DOMException && error.name === "AbortError")) {
        patch(next.localId, { status: "cancelled", progress: undefined, error: undefined });
        return;
      }
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      if (error instanceof Error && error.message === "BACKGROUND") {
        patch(next.localId, {
          status: "background",
          progress: "Käsittely jatkuu taustalla",
          error: "Näet tilanteen töistä. Muut tiedostot jatkuvat.",
        });
        return;
      }
      // A genuine network failure (timeout, gateway 502/503/504, or the
      // connection simply dropped) never reaches readJson, so it is
      // never an ApiError -- unlike a real 4xx business rejection, which
      // always is. Task 10: on the mobile build this file is handed to
      // the offline queue instead of being shown as "failed".
      if (callbacksRef.current.onNetworkFailure && !(error instanceof ApiError)) {
        callbacksRef.current.onNetworkFailure(next.file);
        patch(next.localId, { status: "cancelled", progress: undefined, error: undefined });
        return;
      }
      const existingId = duplicateReceiptId(error);
      patch(next.localId, {
        status: "failed",
        progress: undefined,
        error: errorMessage(error, "Lataus epäonnistui"),
        duplicateReceiptId: existingId ?? undefined,
      });
    } finally {
      cancelListeners.current.delete(next.localId);
    }
  }

  async function drain() {
    if (draining.current) return;
    draining.current = true;
    cancelAll.current = false;
    // A bounded few files are read at the same time instead of one after
    // another: each lane takes the next pending row; uploadOne marks it before
    // its first await, so a row is claimed exactly once.
    try {
      await drainQueue(
        () => rowsRef.current,
        runRow,
        UPLOAD_CONCURRENCY,
        () => cancelAll.current
      );
    } finally {
      draining.current = false;
    }
  }

  function enqueue(files: File[]) {
    // Every picked file becomes a row, valid or not: a 200-file migration must
    // not lose files to one bad one.
    const additions = files.map((file) =>
      rowFromFile(file, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    );
    commit([...rowsRef.current, ...additions]);
    void drain();
  }

  function cancel() {
    cancelAll.current = true;
    for (const stop of cancelListeners.current.values()) stop();
    commit(cancelPendingWork(rowsRef.current));
  }

  function retryFailed() {
    const next = retryFailedOnly(rowsRef.current);
    commit(next);
    void drain();
  }

  function useReady(localId: string) {
    const row = rowsRef.current.find((item) => item.localId === localId);
    if (row?.ready) callbacksRef.current.onReady(row.ready);
  }

  // Each internal row carries its own public row (see `listed`), so an unchanged
  // row keeps its identity across renders: a memoized list row repaints on its
  // own change only, not on every poll tick of another file.
  const visible: ReceiptQueueRow[] = rows.map((row) => row.listed);

  return { rows: visible, enqueue, cancel, retryFailed, useReady };
}
