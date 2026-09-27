/**
 * Local drafts for the long editors (invoice, customer, receipt).
 *
 * What is stored: the text the user typed into that form, plus a saved-at time.
 * What is not stored: passwords, tokens, session cookies, IMAP/SMTP secrets,
 * IBANs, or file bytes. A payload with any of those keys is refused.
 * TTL: 7 days from the last edit. A successful save or an explicit discard
 * deletes the draft. A WebView reload within the TTL offers the same text back.
 *
 * Keys are scoped to the signed-in user. Logout and an account switch drop
 * every draft that does not belong to the user who is about to type.
 * Unscoped keys from older builds are deleted, not adopted.
 */
export const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const STORAGE_PREFIX = "lashkirja.draft.v1:";
const SECRET_KEY = /password|secret|token|iban|smtp|imap|cookie|session/i;

export interface DraftEnvelope<T> {
  savedAt: number;
  value: T;
}

export interface DraftStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
  keys(): string[];
}

const memory = new Map<string, string>();

export const memoryDraftStorage: DraftStorage = {
  get: (key) => memory.get(key) ?? null,
  set: (key, value) => {
    memory.set(key, value);
  },
  remove: (key) => {
    memory.delete(key);
  },
  keys: () => [...memory.keys()],
};

let draftOwner: string | null = null;
const ownerListeners = new Set<() => void>();

export function currentDraftOwner(): string | null {
  return draftOwner;
}

export function subscribeDraftOwner(listener: () => void): () => void {
  ownerListeners.add(listener);
  return () => ownerListeners.delete(listener);
}

function notifyDraftOwner(): void {
  for (const listener of ownerListeners) listener();
}

/** Storage key for one user's form. The user id is a uuid and contains no colon. */
export function scopedDraftKey(userId: string, logicalKey: string): string {
  return `u:${userId}:${logicalKey}`;
}

function purgeForeignDrafts(userId: string, storage: DraftStorage): void {
  const keep = STORAGE_PREFIX + scopedDraftKey(userId, "");
  for (const key of storage.keys()) {
    if (!key.startsWith(STORAGE_PREFIX) || key.startsWith(keep)) continue;
    storage.remove(key);
  }
}

/**
 * Call when the signed-in user is known, and with null when it is not.
 * Switching user deletes the previous user's drafts and any unscoped keys.
 */
export function setDraftOwner(userId: string | null, storage: DraftStorage | null = browserStorage()): void {
  const next = userId?.trim() || null;
  const changed = draftOwner !== next;
  draftOwner = next;
  if (next && storage) purgeForeignDrafts(next, storage);
  if (changed) notifyDraftOwner();
}

/** Logout: nothing typed by the previous user may remain on this device. */
export function clearAllDrafts(storage: DraftStorage | null = browserStorage()): void {
  if (storage) {
    for (const key of storage.keys()) {
      if (key.startsWith(STORAGE_PREFIX)) storage.remove(key);
    }
  }
  const changed = draftOwner !== null;
  draftOwner = null;
  if (changed) notifyDraftOwner();
}

export function resetDraftMemory(): void {
  memory.clear();
}

function browserStorage(): DraftStorage | null {
  if (typeof window === "undefined") return null;
  try {
    const storage = window.localStorage;
    return {
      get: (key) => storage.getItem(key),
      set: (key, value) => storage.setItem(key, value),
      remove: (key) => storage.removeItem(key),
      keys: () => {
        const found: string[] = [];
        for (let index = 0; index < storage.length; index += 1) {
          const key = storage.key(index);
          if (key) found.push(key);
        }
        return found;
      },
    };
  } catch {
    return null;
  }
}

export function draftHasSecret(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const stack = [value as Record<string, unknown>];
  const seen = new Set<unknown>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    for (const [key, nested] of Object.entries(current)) {
      if (SECRET_KEY.test(key)) return true;
      if (nested && typeof nested === "object") stack.push(nested as Record<string, unknown>);
    }
  }
  return false;
}

function storageKeyFor(logicalKey: string): string | null {
  if (!draftOwner) return null;
  return STORAGE_PREFIX + scopedDraftKey(draftOwner, logicalKey);
}

export function saveDraft<T>(key: string, value: T, now = Date.now(), storage: DraftStorage | null = browserStorage()): boolean {
  const storageKey = storageKeyFor(key);
  if (!storage || !storageKey || draftHasSecret(value)) return false;
  const envelope: DraftEnvelope<T> = { savedAt: now, value };
  storage.set(storageKey, JSON.stringify(envelope));
  return true;
}

export function readDraft<T>(
  key: string,
  now = Date.now(),
  storage: DraftStorage | null = browserStorage()
): DraftEnvelope<T> | null {
  const storageKey = storageKeyFor(key);
  if (!storage || !storageKey) return null;
  const raw = storage.get(storageKey);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as DraftEnvelope<T>;
    if (!parsed || typeof parsed.savedAt !== "number" || parsed.value === undefined) return null;
    if (now - parsed.savedAt > DRAFT_TTL_MS) {
      storage.remove(storageKey);
      return null;
    }
    if (draftHasSecret(parsed.value)) {
      storage.remove(storageKey);
      return null;
    }
    return parsed;
  } catch {
    storage.remove(storageKey);
    return null;
  }
}

export function clearDraft(key: string, storage: DraftStorage | null = browserStorage()): void {
  const storageKey = storageKeyFor(key);
  if (storageKey) storage?.remove(storageKey);
}
