/**
 * The persistent, encrypted, per-user cache backing an instant mobile
 * launch. Built against the generic `IdbLike` store (idb.ts) and an
 * already-imported AES-GCM key (crypto-box.ts) rather than against
 * `indexedDB` directly, so `createPersistentCache`'s own logic -- limits,
 * LRU eviction, max-age pruning, prefix delete, userId isolation -- is
 * unit-testable in plain Node against an in-memory fake. The real adapter
 * (`openPersistentCache`) is exercised for real in Playwright (Task 7's
 * `cache.spec.ts`).
 *
 * Only `value` is encrypted (crypto-box.ts, `plaintext = JSON.stringify
 * (value)`): `key`, `userId` and `fetchedAt` stay plaintext on the stored
 * row so eviction and prefix queries never need to decrypt.
 */
import { CACHE_STORE, openIndexedDbLike, type IdbLike } from "./idb";
import {
  decryptJson,
  encryptJson,
  generateCacheKeyBase64,
  importCacheKey,
  isCryptoAvailable,
} from "./crypto-box";
import { secureStore, SECURE_KEYS } from "@/lib/mobile/secure-store";

export interface CacheRecord<T = unknown> {
  key: string; // "page:<screen key>" or "http:<path+query>"
  userId: string; // owner; a different signed-in user never reads it
  fetchedAt: number; // epoch ms of the successful network response
  value: T;
}

interface StoredRow {
  key: string;
  userId: string;
  fetchedAt: number;
  iv: Uint8Array<ArrayBuffer>;
  data: ArrayBuffer;
}

export interface PersistentCache {
  get<T>(key: string): Promise<CacheRecord<T> | null>;
  set<T>(key: string, value: T, fetchedAt?: number): Promise<void>;
  delete(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
  entries(prefix: string): Promise<CacheRecord[]>; // boot hydration
  clear(): Promise<void>; // logout, expiry, user switch
}

export const PERSISTENT_LIMITS = {
  pageEntries: 80,
  httpEntries: 300,
  httpBodyMaxBytes: 512 * 1024,
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
} as const;

function limitFor(key: string): number | null {
  if (key.startsWith("page:")) return PERSISTENT_LIMITS.pageEntries;
  if (key.startsWith("http:")) return PERSISTENT_LIMITS.httpEntries;
  return null;
}

/** "page:" or "http:" -- the group an entry-count limit applies within. */
function groupPrefixFor(key: string): string {
  const colon = key.indexOf(":");
  return colon >= 0 ? key.slice(0, colon + 1) : key;
}

/**
 * Built against `IdbLike` and an already-imported key so tests can pass an
 * in-memory fake and a throwaway key -- no real IndexedDB, no jsdom, no
 * secure store. `openPersistentCache` below is the real, wired-up factory.
 */
export function createPersistentCache(
  idb: IdbLike,
  userId: string,
  key: CryptoKey,
  now: () => number = Date.now
): PersistentCache {
  async function ownRows(): Promise<StoredRow[]> {
    const rows = await idb.getAll<StoredRow>(CACHE_STORE);
    return rows.filter((row) => row.userId === userId);
  }

  /** Deletes and reports true when this row is past its max age. */
  async function dropIfExpired(row: StoredRow): Promise<boolean> {
    if (now() - row.fetchedAt <= PERSISTENT_LIMITS.maxAgeMs) return false;
    await idb.delete(CACHE_STORE, row.key);
    return true;
  }

  /** A tampered or undecryptable row is a cache miss, not a crash -- and
   * it is dropped so it does not keep failing forever. */
  async function decodeRow<T>(row: StoredRow): Promise<CacheRecord<T> | null> {
    try {
      const value = await decryptJson<T>(key, { iv: row.iv, data: row.data });
      return { key: row.key, userId: row.userId, fetchedAt: row.fetchedAt, value };
    } catch {
      await idb.delete(CACHE_STORE, row.key);
      return null;
    }
  }

  async function enforceLimit(insertedKey: string): Promise<void> {
    const limit = limitFor(insertedKey);
    if (limit == null) return;
    const group = groupPrefixFor(insertedKey);
    const rows = (await ownRows()).filter((row) => row.key.startsWith(group));
    if (rows.length <= limit) return;
    const excess = rows.length - limit;
    const oldest = [...rows].sort((a, b) => a.fetchedAt - b.fetchedAt).slice(0, excess);
    await Promise.all(oldest.map((row) => idb.delete(CACHE_STORE, row.key)));
  }

  return {
    async get<T>(recordKey: string) {
      const row = await idb.get<StoredRow>(CACHE_STORE, recordKey);
      if (!row || row.userId !== userId) return null;
      if (await dropIfExpired(row)) return null;
      return decodeRow<T>(row);
    },

    async set<T>(recordKey: string, value: T, fetchedAt = now()) {
      const box = await encryptJson(key, value);
      await idb.put<StoredRow>(CACHE_STORE, {
        key: recordKey,
        userId,
        fetchedAt,
        iv: box.iv,
        data: box.data,
      });
      await enforceLimit(recordKey);
    },

    async delete(recordKey) {
      await idb.delete(CACHE_STORE, recordKey);
    },

    async deletePrefix(prefix) {
      const rows = await ownRows();
      await Promise.all(
        rows.filter((row) => row.key.startsWith(prefix)).map((row) => idb.delete(CACHE_STORE, row.key))
      );
    },

    async entries(prefix) {
      const rows = (await ownRows()).filter((row) => row.key.startsWith(prefix));
      const results: CacheRecord[] = [];
      for (const row of rows) {
        if (await dropIfExpired(row)) continue;
        const decoded = await decodeRow(row);
        if (decoded) results.push(decoded);
      }
      return results;
    },

    async clear() {
      await idb.clear(CACHE_STORE);
    },
  };
}

/**
 * A cheap boot-time peek at whose data (if any) the persistent cache
 * currently holds -- no key needed, since `userId` sits in plaintext on
 * each row. Used only to decide whether a user switch needs a full wipe
 * before the newly signed-in user's own cache opens (a defensive check:
 * the normal path already wipes on logout/expiry, this only catches the
 * app being killed before that finished). Returns null when there is no
 * IndexedDB, no rows, or crypto is unavailable.
 */
export async function peekCacheOwner(): Promise<string | null> {
  if (!isCryptoAvailable()) return null;
  const idb = await openIndexedDbLike();
  if (!idb) return null;
  try {
    const rows = await idb.getAll<StoredRow>(CACHE_STORE);
    return rows[0]?.userId ?? null;
  } catch {
    return null;
  }
}

/**
 * Final review I1: `openPersistentCache` and `receipt-queue.ts`'s
 * `queueCryptoKey` each used to independently do their own
 * read-if-absent-generate-and-write against the same
 * `SECURE_KEYS.cacheKey` slot, with no lock between them. If both ran in
 * the same tick with no key present yet (a fresh device's first launch
 * racing a receipt capture before the cache ever opened), each generated
 * and wrote a *different* random key -- whichever `secureStore().set()`
 * finished last silently won, and the loser's already-encrypted data
 * became permanently undecryptable.
 *
 * This module is now the single owner of that key's provisioning.
 * `ensureCacheKey()` memoizes the in-flight promise so every concurrent
 * first caller -- this module's own `openPersistentCache` and
 * `receipt-queue.ts`'s `queueCryptoKey`, which imports this function
 * instead of running its own copy -- shares one provisioning attempt
 * instead of racing independent ones. After writing a freshly-generated
 * key it is read back from the Keychain before being trusted (a write
 * that silently failed to persist would otherwise decrypt fine for the
 * rest of this process and then vanish on the next launch). A failed
 * attempt is not memoized, so the next call retries rather than being
 * stuck forever on a transient store error.
 */
let cacheKeyPromise: Promise<string> | null = null;

async function provisionCacheKey(): Promise<string> {
  const existing = await secureStore().get(SECURE_KEYS.cacheKey);
  if (existing) return existing;
  const generated = generateCacheKeyBase64();
  await secureStore().set(SECURE_KEYS.cacheKey, generated);
  const readBack = await secureStore().get(SECURE_KEYS.cacheKey);
  if (readBack !== generated) {
    throw new Error("cache key write did not persist");
  }
  return readBack;
}

/** The shared, memoized provisioning lock -- call this, never
 * `secureStore()` directly, to read or create the cache key. */
export function ensureCacheKey(): Promise<string> {
  if (!cacheKeyPromise) {
    cacheKeyPromise = provisionCacheKey().catch((error) => {
      cacheKeyPromise = null;
      throw error;
    });
  }
  return cacheKeyPromise;
}

/** I3: called by `wipePersistentCache` so a wipe's key removal can never
 * be shadowed by a stale in-memory promise still holding the *old* key --
 * the next `ensureCacheKey()` call (a fresh sign-in) is guaranteed to see
 * "no key" and provision a new one rather than reusing this process's
 * cached value. */
export function resetCacheKeyProvisioning(): void {
  cacheKeyPromise = null;
}

/**
 * The AES-GCM key lives at `SECURE_KEYS.cacheKey`, generated on first use.
 * `null` when IndexedDB or `crypto.subtle` is unavailable: callers fall
 * back to memory only (secure-store.ts's own memory/emulation/Keychain
 * split decides where the key itself lives).
 */
export async function openPersistentCache(userId: string): Promise<PersistentCache | null> {
  if (!isCryptoAvailable()) return null;
  const idb = await openIndexedDbLike();
  if (!idb) return null;

  const rawKey = await ensureCacheKey();
  const key = await importCacheKey(rawKey);
  return createPersistentCache(idb, userId, key);
}

/**
 * The crypto-shred wipe: every row gone, and the AES-GCM key itself
 * deleted so no previously-written ciphertext could ever be decrypted
 * again, even from a leftover row this call somehow missed. Called on
 * logout, session expiry and (indirectly, via `activatePersistentCache`'s
 * own owner check) a user switch. Never throws -- a wipe that fails
 * halfway is still strictly safer than one that throws and leaves the
 * caller unsure whether anything was cleared.
 */
export async function wipePersistentCache(): Promise<void> {
  try {
    const idb = await openIndexedDbLike();
    if (idb) await idb.clear(CACHE_STORE);
  } catch {
    // Best effort -- the key removal below still runs either way.
  }
  try {
    await secureStore().remove(SECURE_KEYS.cacheKey);
  } catch {
    // Nothing more this function can do.
  } finally {
    // I3: drop the in-memory provisioning lock too, or a fast re-login
    // right after this wipe could see `ensureCacheKey()` still resolved to
    // the just-deleted key instead of provisioning a fresh one.
    resetCacheKeyProvisioning();
  }
}
