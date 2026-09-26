import { createHash, randomBytes, timingSafeEqual } from "crypto";

export const AUTH_STATE_TTL_MS = 60 * 60 * 1000;
export const BANK_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const BANK_SYNC_OVERLAP_DAYS = 5;
const NINETY_DAYS_SECONDS = 90 * 24 * 60 * 60;

export function createAuthState(): string {
  return randomBytes(32).toString("hex");
}

export function hashAuthState(state: string): string {
  return createHash("sha256").update(state, "utf8").digest("hex");
}

export function authStateMatches(storedHash: string | null, state: string): boolean {
  if (!storedHash) return false;
  const actual = Buffer.from(hashAuthState(state));
  const expected = Buffer.from(storedHash);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export function isPendingStateFresh(createdAt: Date, now = new Date()): boolean {
  return now.getTime() - createdAt.getTime() <= AUTH_STATE_TTL_MS;
}

export function isBankSyncDue(lastSyncAt: Date | null, now = new Date()): boolean {
  if (!lastSyncAt) return true;
  return now.getTime() - lastSyncAt.getTime() >= BANK_SYNC_INTERVAL_MS;
}

export function overlapDateFrom(lastSuccessAt: Date): string {
  const from = new Date(
    lastSuccessAt.getTime() - BANK_SYNC_OVERLAP_DAYS * 24 * 60 * 60 * 1000
  );
  return from.toISOString().slice(0, 10);
}

/** Consent end sent to POST /auth. Stays inside the ASPSP maximum. */
export function consentValidUntil(maximumConsentValiditySeconds: number, now = new Date()): string {
  const provided = Number.isFinite(maximumConsentValiditySeconds)
    ? Math.floor(maximumConsentValiditySeconds)
    : 0;
  const seconds = provided > 3600 ? provided - 60 : NINETY_DAYS_SECONDS;
  return new Date(now.getTime() + seconds * 1000).toISOString();
}

export function psuIdForUser(userId: string): string {
  return createHash("sha256").update(`lashkirja:${userId}`, "utf8").digest("hex");
}
