/**
 * The Kirjanpito hub loads five independent values. When one of them failed
 * and there is nothing cached to show in its place, the hub says so once, with
 * one retry (L7), instead of leaving the row quietly empty (F34).
 */
export interface HubSlot {
  /** The load failed. */
  failed: boolean;
  /** Nothing cached to show instead. */
  empty: boolean;
  error?: unknown;
}

/** The first slot that failed with nothing to show, or null when the hub is fine. */
export function firstHubFailure(slots: HubSlot[]): { error: unknown } | null {
  for (const slot of slots) {
    if (slot.failed && slot.empty) return { error: slot.error ?? new Error("load failed") };
  }
  return null;
}
