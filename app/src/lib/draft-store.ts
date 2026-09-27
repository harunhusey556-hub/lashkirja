/**
 * Local drafts for the long editors (invoice, customer, receipt).
 *
 * What is stored: the text the user typed into that form, plus a saved-at time.
 * What is not stored: passwords, tokens, session cookies, IMAP/SMTP secrets,
 * IBANs, or file bytes. A payload with any of those keys is refused.
 * TTL: 7 days from the last edit. A successful save or an explicit discard
 * deletes the draft. A WebView reload within the TTL offers the same text back.
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
};

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

export function saveDraft<T>(key: string, value: T, now = Date.now(), storage: DraftStorage | null = browserStorage()): boolean {
  if (!storage || draftHasSecret(value)) return false;
  const envelope: DraftEnvelope<T> = { savedAt: now, value };
  storage.set(STORAGE_PREFIX + key, JSON.stringify(envelope));
  return true;
}

export function readDraft<T>(
  key: string,
  now = Date.now(),
  storage: DraftStorage | null = browserStorage()
): DraftEnvelope<T> | null {
  if (!storage) return null;
  const raw = storage.get(STORAGE_PREFIX + key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as DraftEnvelope<T>;
    if (!parsed || typeof parsed.savedAt !== "number" || parsed.value === undefined) return null;
    if (now - parsed.savedAt > DRAFT_TTL_MS) {
      storage.remove(STORAGE_PREFIX + key);
      return null;
    }
    if (draftHasSecret(parsed.value)) {
      storage.remove(STORAGE_PREFIX + key);
      return null;
    }
    return parsed;
  } catch {
    storage.remove(STORAGE_PREFIX + key);
    return null;
  }
}

export function clearDraft(key: string, storage: DraftStorage | null = browserStorage()): void {
  storage?.remove(STORAGE_PREFIX + key);
}
