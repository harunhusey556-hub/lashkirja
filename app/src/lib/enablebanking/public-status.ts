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
