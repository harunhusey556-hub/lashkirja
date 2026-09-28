/**
 * AES-GCM 256 encryption for one JSON value at a time -- the persistent
 * cache's only cryptography. The key is a raw 32 random bytes, base64
 * encoded for storage at `SECURE_KEYS.cacheKey` (secure-store.ts), and
 * imported non-extractable here so it can be used but never read back out
 * of `crypto.subtle` as raw bytes by anything else in the page.
 *
 * Uses `globalThis.crypto.subtle`, present in Node 20+ (this repo runs on
 * Node 24 -- see CI), every evergreen browser, and WKWebView.
 */
const IV_BYTES = 12;
const KEY_BYTES = 32;

export interface EncryptedBox {
  iv: Uint8Array<ArrayBuffer>;
  data: ArrayBuffer;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** A fresh random key, base64 encoded -- what gets written to the secure
 * store. Never logged, never returned decoded. */
export function generateCacheKeyBase64(): string {
  const raw = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  return bytesToBase64(raw);
}

/** Imported non-extractable: usable for encrypt/decrypt, never exportable
 * back to raw bytes through the WebCrypto API itself. */
export async function importCacheKey(rawBase64: string): Promise<CryptoKey> {
  const raw = base64ToBytes(rawBase64);
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptJson(key: CryptoKey, value: unknown): Promise<EncryptedBox> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return { iv, data };
}

/** Throws (does not silently return garbage) on a tampered ciphertext,
 * wrong key, or wrong IV -- AES-GCM's authentication tag check fails. */
export async function decryptJson<T>(key: CryptoKey, box: EncryptedBox): Promise<T> {
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: box.iv }, key, box.data);
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

export function isCryptoAvailable(): boolean {
  return typeof crypto !== "undefined" && typeof crypto.subtle !== "undefined";
}
