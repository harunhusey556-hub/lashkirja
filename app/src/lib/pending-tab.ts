/**
 * OWN-19: the tapped tab lights up on the tap, before the new screen lands.
 * That "pending" highlight belongs to the screen it was tapped on only:
 * - any path change drops it (the push landed and the landed tab takes over,
 *   or some other navigation won; either way a later return to the old path
 *   must not light the stale tab again or pick the wrong pop-to-root move);
 * - a push that never lands (failed, blocked) drops it after
 *   PENDING_TAB_TIMEOUT_MS, so the bar goes back to the real tab.
 */
export interface PendingTab {
  id: string;
  from: string;
}

export const PENDING_TAB_TIMEOUT_MS = 4000;

/** The pending tab that still applies on `pathname`, or null when it must be dropped. */
export function keepPendingTab(pending: PendingTab | null, pathname: string): PendingTab | null {
  return pending && pending.from === pathname ? pending : null;
}
