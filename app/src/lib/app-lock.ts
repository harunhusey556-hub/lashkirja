import { acceptableAppPin } from "@/lib/session-policy";

export const APP_LOCK_STORAGE_KEY = "lashkirja.app-lock.v1";
const ATTEMPT_PREFIX = "lashkirja.app-lock.attempts.v1:";
const BIOMETRIC_PREFIX = "lashkirja.app-lock.biometric.v1:";

export interface AppLockRecord {
  salt: string;
  hash: string;
}

export interface PinAttemptState {
  count: number;
  lockedUntil: number;
}

export interface LockStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
  keys(): string[];
}

/** 1s, 2s, 4s, 8s, 16s, then 30s. */
export function pinBackoffMs(failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(30_000, 1000 * 2 ** (failures - 1));
}

export function registerPinFailure(state: PinAttemptState | null, now: number): PinAttemptState {
  const count = (state?.count ?? 0) + 1;
  return { count, lockedUntil: now + pinBackoffMs(count) };
}

export function appLockStorageKey(userId: string): string {
  return `${APP_LOCK_STORAGE_KEY}:${userId}`;
}

export async function hashAppPin(pin: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(`${salt}:${pin}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createAppLockRecord(pin: string): Promise<AppLockRecord | null> {
  if (!acceptableAppPin(pin)) return null;
  const salt = [...crypto.getRandomValues(new Uint8Array(16))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return { salt, hash: await hashAppPin(pin, salt) };
}

export async function appLockMatches(record: AppLockRecord, pin: string): Promise<boolean> {
  const next = await hashAppPin(pin, record.salt);
  if (next.length !== record.hash.length) return false;
  let diff = 0;
  for (let i = 0; i < next.length; i++) diff |= next.charCodeAt(i) ^ record.hash.charCodeAt(i);
  return diff === 0;
}

const lockListeners = new Set<() => void>();

export function subscribeAppLock(listener: () => void): () => void {
  lockListeners.add(listener);
  return () => lockListeners.delete(listener);
}

function emitAppLock(): void {
  for (const listener of lockListeners) listener();
}

function browserLockStorage(): LockStorage | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const storage = localStorage;
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

function dropLegacyLock(storage: LockStorage): void {
  if (storage.get(APP_LOCK_STORAGE_KEY)) storage.remove(APP_LOCK_STORAGE_KEY);
}

export function readAppLock(userId: string | null, storage: LockStorage | null = browserLockStorage()): AppLockRecord | null {
  if (!storage || !userId) return null;
  dropLegacyLock(storage);
  try {
    const raw = storage.get(appLockStorageKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AppLockRecord;
    if (!parsed?.salt || !parsed?.hash) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeAppLock(
  userId: string,
  record: AppLockRecord,
  storage: LockStorage | null = browserLockStorage()
): void {
  if (!storage || !userId) return;
  dropLegacyLock(storage);
  storage.set(appLockStorageKey(userId), JSON.stringify(record));
  emitAppLock();
}

export function clearAppLock(userId: string | null, storage: LockStorage | null = browserLockStorage()): void {
  if (!storage) return;
  dropLegacyLock(storage);
  if (userId) {
    storage.remove(appLockStorageKey(userId));
    storage.remove(ATTEMPT_PREFIX + userId);
    storage.remove(BIOMETRIC_PREFIX + userId);
  }
  emitAppLock();
}

export function biometricUnlockKey(userId: string): string {
  return BIOMETRIC_PREFIX + userId;
}

/** Opt-in Face ID / Touch ID for this user's glance lock. Useless without a PIN. */
export function readBiometricUnlock(
  userId: string | null,
  storage: LockStorage | null = browserLockStorage()
): boolean {
  if (!storage || !userId) return false;
  if (!readAppLock(userId, storage)) return false;
  return storage.get(biometricUnlockKey(userId)) === "1";
}

export function writeBiometricUnlock(
  userId: string,
  enabled: boolean,
  storage: LockStorage | null = browserLockStorage()
): void {
  if (!storage || !userId) return;
  const key = biometricUnlockKey(userId);
  if (enabled) storage.set(key, "1");
  else storage.remove(key);
  emitAppLock();
}

export function deviceHasAnyAppLock(storage: LockStorage | null = browserLockStorage()): boolean {
  if (!storage) return false;
  return storage.keys().some((key) => key.startsWith(`${APP_LOCK_STORAGE_KEY}:`));
}

export function readPinAttempts(
  userId: string,
  storage: LockStorage | null = browserLockStorage()
): PinAttemptState | null {
  if (!storage) return null;
  try {
    const raw = storage.get(ATTEMPT_PREFIX + userId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PinAttemptState;
    if (typeof parsed.count !== "number" || typeof parsed.lockedUntil !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writePinAttempts(
  userId: string,
  state: PinAttemptState | null,
  storage: LockStorage | null = browserLockStorage()
): void {
  if (!storage) return;
  const key = ATTEMPT_PREFIX + userId;
  if (!state || state.count <= 0) storage.remove(key);
  else storage.set(key, JSON.stringify(state));
}
