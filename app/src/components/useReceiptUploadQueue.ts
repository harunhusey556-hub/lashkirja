"use client";

import { useRef, useState } from "react";
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
  retryFailedOnly,
  type UploadQueueStatus,
} from "@/lib/upload-queue";

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

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
  fieldConfidence?: { vendor?: number; date?: number; totalAmount?: number } | null;
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
}

interface InternalRow extends ReceiptQueueRow {
  file: File;
  jobId?: string;
  ready?: ReadyUpload;
}

function validateUploadFile(file: File): string | null {
  if (file.size === 0) return "Tiedosto on tyhjä";
  if (file.size > MAX_UPLOAD_BYTES) return "Tiedosto on liian suuri (enintään 15 Mt)";
  const name = file.name.toLowerCase();
  const okExt = /\.(pdf|jpe?g|png|heic|heif)$/.test(name);
  const okMime = file.type === "application/pdf" || file.type.startsWith("image/");
  if (!okExt && !okMime) return "Tuemme PDF-, JPG-, PNG- ja HEIC-tiedostoja";
  return null;
}

function duplicateReceiptId(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.status !== 409 || !error.details) return null;
  if (typeof error.details !== "object" || error.details === null) return null;
  const id = (error.details as { receiptId?: unknown }).receiptId;
  return typeof id === "string" && id ? id : null;
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

export function useReceiptUploadQueue(onReady: (upload: ReadyUpload) => void) {
  const [rows, setRows] = useState<InternalRow[]>([]);
  const rowsRef = useRef<InternalRow[]>([]);
  const onReadyRef = useRef(onReady);
  const draining = useRef(false);
  const cancelAll = useRef(false);
  const applied = useRef(false);
  const cancelListeners = useRef(new Map<string, () => void>());
  onReadyRef.current = onReady;

  function commit(next: InternalRow[]) {
    rowsRef.current = next;
    setRows(next);
  }

  function patch(localId: string, partial: Partial<InternalRow>) {
    commit(rowsRef.current.map((row) => (row.localId === localId ? { ...row, ...partial } : row)));
  }

  async function pollJob(jobId: string, signal: AbortSignal): Promise<ExtractedUpload> {
    for (let attempt = 0; attempt < 90; attempt += 1) {
      const response = await apiFetch(`/api/jobs/${jobId}`, { signal, timeoutMs: 20_000 });
      const data = await readJson<{
        job: { status: string; error?: string | null; extracted?: ExtractedUpload | null; progressLabel?: string | null };
      }>(response, "Kuitin käsittely epäonnistui");
      if (data.job.progressLabel) {
        const current = rowsRef.current.find((row) => row.jobId === jobId);
        if (current) patch(current.localId, { progress: data.job.progressLabel });
      }
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
      extracted = await pollJob(data.jobId, signal);
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
    patch(row.localId, {
      status: "ready",
      progress: RECEIPT_PHASE.review,
      ready,
      error: undefined,
    });
    if (!applied.current) {
      applied.current = true;
      onReadyRef.current(ready);
    }
  }

  async function drain() {
    if (draining.current) return;
    draining.current = true;
    cancelAll.current = false;
    try {
      while (!cancelAll.current) {
        const next = rowsRef.current.find((row) => row.status === "pending");
        if (!next) break;
        const controller = new AbortController();
        const stop = () => controller.abort();
        if (cancelAll.current) break;
        const onCancel = () => stop();
        cancelListeners.current.set(next.localId, onCancel);
        try {
          await uploadOne(next, controller.signal);
        } catch (error: unknown) {
          if (cancelAll.current || (error instanceof DOMException && error.name === "AbortError")) {
            patch(next.localId, { status: "cancelled", progress: undefined, error: undefined });
            continue;
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
            continue;
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
    } finally {
      draining.current = false;
    }
  }

  function enqueue(files: File[]) {
    const additions: InternalRow[] = files.map((file) => {
      const invalid = validateUploadFile(file);
      return {
        localId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        file,
        name: file.name || "kuitti",
        status: invalid ? "failed" : "pending",
        error: invalid ?? undefined,
      };
    });
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
    if (row?.ready) onReadyRef.current(row.ready);
  }

  const visible: ReceiptQueueRow[] = rows.map(({ file: _file, ready: _ready, jobId: _jobId, ...row }) => row);

  return { rows: visible, enqueue, cancel, retryFailed, useReady };
}
