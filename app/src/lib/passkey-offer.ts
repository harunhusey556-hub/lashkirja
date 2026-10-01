/**
 * The one-time "create a passkey?" offer after a password sign-in. Remembered
 * per account on this device, so it is shown once and never nags. Storage
 * failure (private mode) just means the offer may show again: harmless.
 */
const PREFIX = "lk.passkeyOffer.v1:";

function key(email: string): string {
  return PREFIX + email.trim().toLowerCase();
}

export function passkeyOfferSeen(email: string): boolean {
  try {
    return window.localStorage.getItem(key(email)) === "1";
  } catch {
    return false;
  }
}

export function markPasskeyOfferSeen(email: string): void {
  try {
    window.localStorage.setItem(key(email), "1");
  } catch {
    // Not persisted; see the header.
  }
}
