/**
 * What a client may hear about the Enable Banking setup (BOOKS-03, L5).
 * The detailed reason (`enableBankingStatus().message`) can name settings
 * such as the app id or key file; it goes to the server log only.
 */
export const BANK_NOT_CONFIGURED_MESSAGE = "Pankkiyhteys ei ole käytössä.";

let lastLogged: string | null = null;

/** Logs a missing-setup reason once per distinct reason, not per request. */
export function logBankSetupGap(status: { enabled: boolean; ready: boolean; message?: string }): void {
  if (status.ready || !status.enabled) return;
  const reason = status.message || "unknown";
  if (reason === lastLogged) return;
  lastLogged = reason;
  console.warn("Enable Banking is enabled but not ready:", reason);
}

const hinted = new Set<string>();

/**
 * What the owner of the server has to fix, for the server log only. The person
 * using the app never sees it (L5); each distinct hint is logged once.
 */
export function logBankOperatorHint(hint: string): void {
  if (hinted.has(hint)) return;
  hinted.add(hint);
  console.warn("Enable Banking setup:", hint);
}
