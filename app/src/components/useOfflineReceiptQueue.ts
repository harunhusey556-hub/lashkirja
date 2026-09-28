"use client";

/**
 * The offline receipt queue's drain driver and the reactive rows
 * `QueuedReceiptsCard.tsx` (and the logout confirmation, AppShell.tsx) read.
 * Backed by module-level state (the same pattern connectivity.ts uses for
 * device/server reachability) rather than per-component state, so every
 * mounted consumer -- AppShell's own mount (the driver), the kuitit card,
 * and ReceiptEditor's offline-capture path -- shares one live queue instead
 * of drifting copies. Mobile only: on the web build the hook always
 * returns an empty, inert queue.
 *
 * Drain order: oldest `createdAt` first, one item at a time (`pickNextQueued`).
 * Triggers: first mount for a signed-in user (~ "app start"), the browser's
 * own `online` event, `lashkirja-reconnected` (connectivity.ts, Task 8), the
 * native `App` plugin's `appStateChange` back to active, and a timer set to
 * the earliest still-queued `nextAttemptAt`. A `sending` row found at start
 * (the app was killed mid-send) is put back to `queued` first
 * (`recoverCrashedSends`).
 */
import { useEffect, useState } from "react";
import { apiFetch } from "@/components/clientFetch";
import { useSession } from "@/components/SessionProvider";
import { IS_MOBILE_BUILD } from "@/lib/build-target";
import { onAuthChange } from "@/lib/auth-client";
import {
  classifySendResult,
  decryptQueuedReceiptFile,
  deleteQueuedReceipt,
  earliestNextAttemptAt,
  enqueueReceipt,
  listQueuedReceipts,
  nextAttemptDelayMs,
  pickNextQueued,
  pruneDoneReceipts,
  recoverCrashedSends,
  saveQueuedReceipt,
  clearReceiptQueueStore,
  type QueuedReceipt,
} from "@/lib/offline/receipt-queue";

export interface QueueRow {
  id: string;
  fileName: string;
  status: QueuedReceipt["status"];
  lastError?: string;
}

function toRow(item: QueuedReceipt): QueueRow {
  return { id: item.id, fileName: item.fileName, status: item.status, lastError: item.lastError };
}

const listeners = new Set<() => void>();
let rows: QueueRow[] = [];
let currentUserId: string | null = null;
let wired = false;
let draining = false;
let paused = false;
let drainTimer: ReturnType<typeof setTimeout> | null = null;

function emit(): void {
  for (const listener of listeners) listener();
}

async function refresh(userId: string): Promise<QueuedReceipt[]> {
  const items = await listQueuedReceipts(userId);
  rows = items.map(toRow);
  emit();
  return items;
}

function clearDrainTimer(): void {
  if (drainTimer !== null) {
    clearTimeout(drainTimer);
    drainTimer = null;
  }
}

function scheduleDrain(items: QueuedReceipt[], userId: string): void {
  clearDrainTimer();
  const earliest = earliestNextAttemptAt(items);
  if (earliest == null) return;
  const delay = Math.max(0, earliest - Date.now());
  drainTimer = setTimeout(() => void drain(userId), delay);
}

/** Retry-After (seconds) from a 429, if present and valid. */
function retryAfterMs(response: Response): number {
  const raw = response.headers.get("Retry-After");
  const seconds = raw ? Number(raw) : NaN;
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

async function sendOne(userId: string, item: QueuedReceipt): Promise<void> {
  await saveQueuedReceipt({ ...item, status: "sending" });
  await refresh(userId);

  const blob = await decryptQueuedReceiptFile(item);
  if (!blob) {
    const attempts = item.attempts + 1;
    await saveQueuedReceipt({
      ...item,
      status: "queued",
      attempts,
      nextAttemptAt: Date.now() + nextAttemptDelayMs(attempts),
      lastError: "Salauksen avaus epäonnistui. Yritetään uudelleen.",
    });
    return;
  }

  const form = new FormData();
  form.append("file", blob, item.fileName);
  form.append("capturedAt", item.capturedAt);

  let status: number | "network-error" = "network-error";
  let jobId: string | undefined;
  let serverError: string | undefined;
  let retryDelayMs = 0;
  try {
    const response = await apiFetch("/api/receipts/inbox", {
      method: "POST",
      body: form,
      headers: { "Idempotency-Key": item.id },
      offlineQueue: true,
      timeoutMs: 60_000,
    });
    status = response.status;
    if (status === 429) retryDelayMs = retryAfterMs(response);
    const body = (await response.json().catch(() => null)) as
      | { jobId?: string; error?: string }
      | null;
    jobId = body?.jobId;
    serverError = typeof body?.error === "string" ? body.error : undefined;
  } catch {
    status = "network-error";
  }

  const outcome = classifySendResult(status);
  if (outcome === "done") {
    await saveQueuedReceipt({ ...item, status: "done", lastError: undefined, jobId });
    return;
  }
  if (outcome === "paused") {
    // 401: the token is gone. Leave the row queued -- it is picked up again
    // once onAuthChange (below) sees a fresh sign-in -- but stop draining
    // now so the rest of the queue does not also spend a failed attempt.
    paused = true;
    await saveQueuedReceipt({ ...item, status: "queued" });
    return;
  }
  const attempts = item.attempts + 1;
  if (outcome === "retry") {
    await saveQueuedReceipt({
      ...item,
      status: "queued",
      attempts,
      nextAttemptAt: Date.now() + (retryDelayMs > 0 ? retryDelayMs : nextAttemptDelayMs(attempts)),
      lastError: "Ei yhteyttä. Lähetetään uudelleen automaattisesti.",
    });
    return;
  }
  // "failed": a permanent 4xx -- surfaced in the card with retry/delete.
  await saveQueuedReceipt({
    ...item,
    status: "failed",
    attempts,
    lastError: serverError || "Lähetys epäonnistui.",
  });
}

async function drain(userId: string): Promise<void> {
  if (!IS_MOBILE_BUILD || draining || paused) return;
  draining = true;
  clearDrainTimer();
  try {
    await pruneDoneReceipts(userId);
    let items = await refresh(userId);
    while (!paused) {
      const next = pickNextQueued(items, Date.now());
      if (!next) break;
      await sendOne(userId, next);
      items = await refresh(userId);
    }
    scheduleDrain(items, userId);
  } finally {
    draining = false;
  }
}

function requestDrain(userId: string | null): void {
  if (!IS_MOBILE_BUILD || !userId) return;
  void drain(userId);
}

async function wireAppStateChange(): Promise<void> {
  try {
    const { Capacitor } = await import("@capacitor/core");
    if (!Capacitor.isNativePlatform()) return;
    const { App } = await import("@capacitor/app");
    await App.addListener("appStateChange", (state) => {
      if (state.isActive) requestDrain(currentUserId);
    });
  } catch {
    // No native App plugin (web, or an IPA built before it was added) --
    // the online/reconnect/visibility triggers below still cover it.
  }
}

/** Registers the app-wide triggers exactly once, on the first signed-in
 * mount -- mirrors connectivity.ts's `wireOnce`. */
function wireOnce(): void {
  if (wired || typeof window === "undefined") return;
  wired = true;
  window.addEventListener("online", () => requestDrain(currentUserId));
  document.addEventListener("lashkirja-reconnected", () => requestDrain(currentUserId));
  void wireAppStateChange();
  // A fresh sign-in un-pauses a queue stopped by a 401, and re-arms the
  // queue for whichever user just signed in (a device shared between
  // sessions, or a re-login after an expired one).
  onAuthChange((auth) => {
    if (!auth) return;
    paused = false;
    currentUserId = auth.userId;
    void recoverCrashedSends(auth.userId).then(() => {
      void refresh(auth.userId).then((items) => {
        requestDrain(auth.userId);
        scheduleDrain(items, auth.userId);
      });
    });
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): QueueRow[] {
  return rows;
}

/** Logout: the queue's own store is wiped alongside the persistent cache
 * (auth-client.ts's `clearClientAuthState` calls this). Resets the
 * in-memory singleton too, so a next sign-in (possibly a different user)
 * starts from a clean slate rather than an unpaused-but-stale state. */
export async function resetOfflineReceiptQueueForLogout(): Promise<void> {
  clearDrainTimer();
  paused = false;
  currentUserId = null;
  rows = [];
  emit();
  await clearReceiptQueueStore();
}

export function useOfflineReceiptQueue() {
  const { status, user } = useSession();
  const userId = user?.userId ?? null;
  const [snapshot, setSnapshot] = useState<QueueRow[]>(getSnapshot);

  useEffect(() => subscribe(() => setSnapshot(getSnapshot())), []);

  useEffect(() => {
    if (!IS_MOBILE_BUILD || status !== "signed-in" || !userId) return;
    currentUserId = userId;
    wireOnce();
    void recoverCrashedSends(userId).then(() => {
      void refresh(userId).then((items) => {
        requestDrain(userId);
        scheduleDrain(items, userId);
      });
    });
  }, [status, userId]);

  async function retry(id: string): Promise<void> {
    if (!userId) return;
    const items = await listQueuedReceipts(userId);
    const item = items.find((row) => row.id === id);
    if (!item) return;
    await saveQueuedReceipt({ ...item, status: "queued", nextAttemptAt: Date.now(), lastError: undefined });
    paused = false;
    await refresh(userId);
    requestDrain(userId);
  }

  async function remove(id: string): Promise<void> {
    await deleteQueuedReceipt(id);
    if (userId) await refresh(userId);
  }

  async function enqueueFiles(files: File[], capturedAt: string = new Date().toISOString()): Promise<void> {
    if (!userId) return;
    for (const file of files) {
      await enqueueReceipt({
        userId,
        file,
        fileName: file.name || "kuitti",
        mimeType: file.type || "application/octet-stream",
        capturedAt,
      });
    }
    await refresh(userId);
    requestDrain(userId);
  }

  return { rows: IS_MOBILE_BUILD ? snapshot : [], retry, remove, enqueueFiles };
}
