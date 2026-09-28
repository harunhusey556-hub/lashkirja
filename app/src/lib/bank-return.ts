/**
 * Bank authorization return.
 *
 * The bank leaves our origin. Coming back is a callback URL (success, cancel,
 * or an expired session) or a return to the app with the pending marker still
 * set, which means the user backed out before the bank redirected.
 */

export type BankReturnKind = "success" | "cancelled" | "expired" | "missing" | "failed";

const CANCELLED = new Set(["access_denied", "cancelled", "canceled", "user_cancel"]);
const EXPIRED = new Set([
  "expired",
  "session_expired",
  "login_required",
  "consent_expired",
  "interaction_required",
]);

export interface BankReturnInput {
  code?: string | null;
  state?: string | null;
  error?: string | null;
}

export function classifyBankReturn(input: BankReturnInput): {
  kind: BankReturnKind;
  message: string;
} {
  const error = (input.error || "").trim().toLowerCase();
  if (CANCELLED.has(error)) {
    return { kind: "cancelled", message: "Yhdistäminen peruutettiin pankissa." };
  }
  if (EXPIRED.has(error)) {
    return { kind: "expired", message: "Pankin istunto vanheni. Yhdistä uudelleen." };
  }
  if (error) {
    return { kind: "failed", message: "Pankki ei vahvistanut yhteyttä. Yritä uudelleen." };
  }
  if (!input.code || !input.state) {
    return {
      kind: "missing",
      message: "Pankin paluuosoitteesta puuttui vahvistus. Yhdistä uudelleen.",
    };
  }
  return { kind: "success", message: "Yhdistetään pankkiin..." };
}

export const BANK_AUTH_PENDING_KEY = "lashkirja.bank-auth.v1";
const PENDING_MAX_MS = 2 * 60 * 60 * 1000;

export interface PendingBankAuth {
  startedAt: number;
}

export function pendingBankAuthPayload(now = Date.now()): string {
  return JSON.stringify({ startedAt: now } satisfies PendingBankAuth);
}

export function readPendingBankAuth(raw: string | null, now = Date.now()): PendingBankAuth | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PendingBankAuth>;
    if (typeof parsed.startedAt !== "number" || !Number.isFinite(parsed.startedAt)) return null;
    const age = now - parsed.startedAt;
    if (age < 0 || age > PENDING_MAX_MS) return null;
    return { startedAt: parsed.startedAt };
  } catch {
    return null;
  }
}

export const APP_URL_SCHEME = "lashkirja";

/** Prefix on an auth `state` created for an app-started bank consent (see
 * enablebanking/consent.ts createAuthState). Lets a callback URL be routed
 * back into the app without a DB lookup. */
export const APP_BANK_STATE_PREFIX = "app1.";

export function isAppBankState(state: string | null | undefined): boolean {
  return typeof state === "string" && state.startsWith(APP_BANK_STATE_PREFIX);
}

/**
 * Turns the web callback's query string into the app's custom-scheme
 * callback URL: "?code=..&state=app1.." -> "lashkirja://bank/callback?code=..&state=app1..".
 * String concatenation only: whatever encoding the query already carries is
 * preserved byte-for-byte.
 */
export function appReturnUrl(search: string): string {
  const query = !search ? "" : search.startsWith("?") ? search : `?${search}`;
  return `${APP_URL_SCHEME}://bank/callback${query}`;
}

/**
 * In-app path for a callback URL, or null when the URL is not our return.
 * Accepts https://host/bank/callback and the custom scheme a later IPA registers:
 * lashkirja://bank/callback or lashkirja:///bank/callback.
 */
export function bankCallbackPath(url: string): string | null {
  try {
    const parsed = new URL(url);
    const path =
      parsed.protocol === `${APP_URL_SCHEME}:`
        ? parsed.hostname
          ? `/${parsed.hostname}${parsed.pathname === "/" ? "" : parsed.pathname}`
          : parsed.pathname
        : parsed.pathname;
    if (path !== "/bank/callback") return null;
    return `/bank/callback${parsed.search}`;
  } catch {
    return null;
  }
}
