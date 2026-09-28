/**
 * Thin, generic IndexedDB wrapper: `lashkirja-offline` v1, holding two
 * object stores. `persistent-cache.ts` is written against the `IdbLike`
 * interface below, never against `indexedDB` directly, so its own tests
 * can run in plain Node against an in-memory fake -- no jsdom, no new
 * dependency.
 *
 * - "cache": keyPath "key". One row per persisted cache entry, already
 *   encrypted by the caller (crypto-box.ts) before it reaches `put`.
 * - "receipt-queue": keyPath "id", index "userId". Created here so the
 *   schema exists from this task on; Task 10 is the first to read or
 *   write it.
 */
export const OFFLINE_DB_NAME = "lashkirja-offline";
export const OFFLINE_DB_VERSION = 1;
export const CACHE_STORE = "cache";
export const RECEIPT_QUEUE_STORE = "receipt-queue";
export const RECEIPT_QUEUE_USER_INDEX = "userId";

export interface IdbLike {
  get<T>(store: string, key: string): Promise<T | undefined>;
  getAll<T>(store: string): Promise<T[]>;
  put<T>(store: string, value: T): Promise<void>;
  delete(store: string, key: string): Promise<void>;
  clear(store: string): Promise<void>;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CACHE_STORE)) {
        db.createObjectStore(CACHE_STORE, { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains(RECEIPT_QUEUE_STORE)) {
        const store = db.createObjectStore(RECEIPT_QUEUE_STORE, { keyPath: "id" });
        store.createIndex(RECEIPT_QUEUE_USER_INDEX, "userId");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("IndexedDB open blocked"));
  });
}

function runRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

let dbPromise: Promise<IDBDatabase> | null = null;

/** M1: a transient open failure (another tab/webview holding a blocking
 * version-change transaction, a momentary OS storage hiccup) used to be
 * memoized just like a success, permanently degrading the app to
 * memory-only for the rest of that launch even after the underlying cause
 * cleared. Only a successful open is memoized now -- a rejection resets
 * `dbPromise` to null first, so the next call (the next cache read/write)
 * retries `openDatabase()` from scratch instead of reusing the same dead
 * promise forever. */
function getDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = openDatabase().catch((error) => {
      dbPromise = null;
      throw error;
    });
  }
  return dbPromise;
}

/** null when IndexedDB itself is unavailable (older WebViews, some private
 * modes) or fails to open -- callers fall back to memory only. */
export async function openIndexedDbLike(): Promise<IdbLike | null> {
  if (typeof indexedDB === "undefined") return null;
  try {
    const db = await getDb();
    return {
      async get<T>(store: string, key: string) {
        return runRequest<T>(db.transaction(store, "readonly").objectStore(store).get(key));
      },
      async getAll<T>(store: string) {
        return runRequest<T[]>(db.transaction(store, "readonly").objectStore(store).getAll());
      },
      async put<T>(store: string, value: T) {
        await runRequest(db.transaction(store, "readwrite").objectStore(store).put(value));
      },
      async delete(store: string, key: string) {
        await runRequest(db.transaction(store, "readwrite").objectStore(store).delete(key));
      },
      async clear(store: string) {
        await runRequest(db.transaction(store, "readwrite").objectStore(store).clear());
      },
    };
  } catch {
    return null;
  }
}

export function resetIdbForTests(): void {
  dbPromise = null;
}
