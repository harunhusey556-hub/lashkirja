import { acceptableAppPin } from "@/lib/session-policy";

export const APP_LOCK_STORAGE_KEY = "lashkirja.app-lock.v1";

export interface AppLockRecord {
  salt: string;
  hash: string;
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

export function readAppLock(): AppLockRecord | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(APP_LOCK_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AppLockRecord;
    if (!parsed?.salt || !parsed?.hash) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeAppLock(record: AppLockRecord): void {
  localStorage.setItem(APP_LOCK_STORAGE_KEY, JSON.stringify(record));
  emitAppLock();
}

export function clearAppLock(): void {
  localStorage.removeItem(APP_LOCK_STORAGE_KEY);
  emitAppLock();
}
