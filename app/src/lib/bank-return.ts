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

/** In-app path for a callback URL, or null when the URL is not our return. */
export function bankCallbackPath(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.pathname !== "/bank/callback") return null;
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}
