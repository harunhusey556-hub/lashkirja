/**
 * The offline receipt-photo queue: IndexedDB store "receipt-queue" (idb.ts,
 * created in Task 7), one row per captured/picked photo waiting to reach
 * `POST /api/receipts/inbox`. File bytes are encrypted with the same
 * AES-GCM key as the persistent cache (crypto-box.ts's algorithm, the key
 * kept at `SECURE_KEYS.cacheKey` -- persistent-cache.ts's own key) -- a
 * device that already trusts that key with plaintext bookkeeping data
 * trusts it with a receipt photo the same way, and the crypto-shred wipe on
 * logout (Task 7's `wipePersistentCache`, plus `clearReceiptQueueStore`
 * below) makes every queued photo unrecoverable too.
 *
 * Pure queue-state helpers (`nextAttemptDelayMs`, `classifySendResult`,
 * ordering/pruning) are exported separately from the store I/O so they are
 * unit-testable with an in-memory `IdbLike` fake and no real IndexedDB --
 * the same split idb.ts / persistent-cache.ts already use.
 */
import { RECEIPT_QUEUE_STORE, openIndexedDbLike, type IdbLike } from "./idb";
import { generateCacheKeyBase64, importCacheKey, isCryptoAvailable } from "./crypto-box";
import { secureStore, SECURE_KEYS } from "@/lib/mobile/secure-store";

export interface QueuedReceipt {
  id: string; // crypto.randomUUID(); also the Idempotency-Key
  userId: string;
  createdAt: number; // epoch ms
  capturedAt: string; // ISO, device clock
  fileName: string;
  mimeType: string;
  size: number; // bytes, <= 15 * 1024 * 1024
  iv: Uint8Array<ArrayBuffer>; // AES-GCM IV, same key as the cache (Task 7)
  data: ArrayBuffer; // encrypted file bytes
  status: "queued" | "sending" | "failed" | "done";
  attempts: number;
  nextAttemptAt: number; // epoch ms
  lastError?: string; // Finnish, shown in the card
  jobId?: string;
}

/** 5 s, 30 s, 2 min, 10 min, then 30 min forever. `attempts` is the number
 * of send attempts made so far (including the one that just failed) --
 * `nextAttemptDelayMs(1)` is the delay scheduled after the first failure. */
const RETRY_DELAYS_MS = [5_000, 30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000] as const;

export function nextAttemptDelayMs(attempts: number): number {
  const index = Math.min(Math.max(attempts - 1, 0), RETRY_DELAYS_MS.length - 1);
  return RETRY_DELAYS_MS[index];
}

export type SendOutcome = "done" | "retry" | "failed" | "paused";

/** 2xx -> done; 401 -> paused (until next sign-in); 408/429/5xx/network ->
 * retry; other 4xx -> failed. */
export function classifySendResult(status: number | "network-error"): SendOutcome {
  if (status === "network-error") return "retry";
  if (status >= 200 && status < 300) return "done";
  if (status === 401) return "paused";
  if (status === 408 || status === 429) return "retry";
  if (status >= 500 && status < 600) return "retry";
  return "failed";
}

const DONE_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Same AES-GCM key persistent-cache.ts's `openPersistentCache` uses
 * (`SECURE_KEYS.cacheKey`), generated and stored on first use by whichever
 * of the two runs first. Kept independent of persistent-cache.ts's own
 * module (no shared helper) so this file has no import-order coupling to
 * it -- both sides agree only through the storage key's name. */
async function queueCryptoKey(): Promise<CryptoKey | null> {
  if (!isCryptoAvailable()) return null;
  let rawKey = await secureStore().get(SECURE_KEYS.cacheKey);
  if (!rawKey) {
    rawKey = generateCacheKeyBase64();
    await secureStore().set(SECURE_KEYS.cacheKey, rawKey);
  }
  return importCacheKey(rawKey);
}

const IV_BYTES = 12;

/** Raw-byte AES-GCM, not crypto-box.ts's JSON variant -- a receipt photo's
 * bytes must round-trip exactly, with no JSON/UTF-8 detour. Same primitive
 * and key convention as crypto-box.ts, just for an ArrayBuffer instead of a
 * JSON value. */
async function encryptBytes(
  key: CryptoKey,
  data: ArrayBuffer
): Promise<{ iv: Uint8Array<ArrayBuffer>; data: ArrayBuffer }> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const cipherText = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);
  return { iv, data: cipherText };
}

async function decryptBytes(key: CryptoKey, iv: Uint8Array<ArrayBuffer>, data: ArrayBuffer): Promise<ArrayBuffer> {
  return crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
}

/** Drain order: oldest capture first. */
function byCreatedAt(a: QueuedReceipt, b: QueuedReceipt): number {
  return a.createdAt - b.createdAt;
}

export async function enqueueReceipt(
  input: {
    userId: string;
    file: File | Blob;
    fileName: string;
    mimeType: string;
    capturedAt: string;
  },
  idbOverride?: IdbLike
): Promise<QueuedReceipt | null> {
  const idb = idbOverride ?? (await openIndexedDbLike());
  const key = await queueCryptoKey();
  if (!idb || !key) return null;
  const buffer = await input.file.arrayBuffer();
  const box = await encryptBytes(key, buffer);
  const item: QueuedReceipt = {
    id: crypto.randomUUID(),
    userId: input.userId,
    createdAt: Date.now(),
    capturedAt: input.capturedAt,
    fileName: input.fileName,
    mimeType: input.mimeType,
    size: buffer.byteLength,
    iv: box.iv,
    data: box.data,
    status: "queued",
    attempts: 0,
    nextAttemptAt: Date.now(),
  };
  await idb.put(RECEIPT_QUEUE_STORE, item);
  return item;
}

export async function listQueuedReceipts(userId: string, idbOverride?: IdbLike): Promise<QueuedReceipt[]> {
  const idb = idbOverride ?? (await openIndexedDbLike());
  if (!idb) return [];
  const rows = await idb.getAll<QueuedReceipt>(RECEIPT_QUEUE_STORE);
  return rows.filter((row) => row.userId === userId).sort(byCreatedAt);
}

export async function saveQueuedReceipt(item: QueuedReceipt, idbOverride?: IdbLike): Promise<void> {
  const idb = idbOverride ?? (await openIndexedDbLike());
  if (!idb) return;
  await idb.put(RECEIPT_QUEUE_STORE, item);
}

export async function deleteQueuedReceipt(id: string, idbOverride?: IdbLike): Promise<void> {
  const idb = idbOverride ?? (await openIndexedDbLike());
  if (!idb) return;
  await idb.delete(RECEIPT_QUEUE_STORE, id);
}

/** null when crypto is unavailable -- the caller treats this like any other
 * transient send failure and retries later rather than losing the photo. */
export async function decryptQueuedReceiptFile(item: QueuedReceipt): Promise<Blob | null> {
  const key = await queueCryptoKey();
  if (!key) return null;
  const plain = await decryptBytes(key, item.iv, item.data);
  return new Blob([plain], { type: item.mimeType });
}

/** Crash recovery: the app was killed mid-send. A "sending" row found at
 * start goes back to "queued" so the driver picks it up again instead of
 * leaving it stuck forever. */
export async function recoverCrashedSends(userId: string, idbOverride?: IdbLike): Promise<void> {
  const idb = idbOverride ?? (await openIndexedDbLike());
  if (!idb) return;
  const rows = await idb.getAll<QueuedReceipt>(RECEIPT_QUEUE_STORE);
  for (const row of rows) {
    if (row.userId === userId && row.status === "sending") {
      await idb.put(RECEIPT_QUEUE_STORE, { ...row, status: "queued" as const });
    }
  }
}

/** `done` items are deleted 24h after they were captured. */
export async function pruneDoneReceipts(
  userId: string,
  now: number = Date.now(),
  idbOverride?: IdbLike
): Promise<void> {
  const idb = idbOverride ?? (await openIndexedDbLike());
  if (!idb) return;
  const rows = await idb.getAll<QueuedReceipt>(RECEIPT_QUEUE_STORE);
  for (const row of rows) {
    if (row.userId === userId && row.status === "done" && now - row.createdAt > DONE_RETENTION_MS) {
      await idb.delete(RECEIPT_QUEUE_STORE, row.id);
    }
  }
}

/** The next item the driver should send: oldest `queued` row whose
 * `nextAttemptAt` has arrived. `failed` rows are never picked automatically
 * -- only an explicit "Yritä uudelleen" (which puts a row back to `queued`)
 * re-enters this pool. */
export function pickNextQueued(items: QueuedReceipt[], now: number = Date.now()): QueuedReceipt | null {
  const candidates = items.filter((item) => item.status === "queued" && item.nextAttemptAt <= now).sort(byCreatedAt);
  return candidates[0] ?? null;
}

/** The earliest `nextAttemptAt` among still-queued rows, for the driver's
 * timer -- null when there is nothing waiting on a delay. */
export function earliestNextAttemptAt(items: QueuedReceipt[]): number | null {
  const pending = items.filter((item) => item.status === "queued");
  if (pending.length === 0) return null;
  return Math.min(...pending.map((item) => item.nextAttemptAt));
}

/** Logout: every queued photo's row is gone. Combined with
 * `wipePersistentCache`'s removal of `SECURE_KEYS.cacheKey`, any row this
 * call somehow missed is unrecoverable anyway (crypto-shred) -- but the
 * queue is a distinct IndexedDB store from the cache's, so it still needs
 * its own clear. Never throws -- a wipe that fails halfway is still safer
 * than one that throws and leaves the caller unsure whether anything ran. */
export async function clearReceiptQueueStore(idbOverride?: IdbLike): Promise<void> {
  try {
    const idb = idbOverride ?? (await openIndexedDbLike());
    if (idb) await idb.clear(RECEIPT_QUEUE_STORE);
  } catch {
    // Best effort.
  }
}
