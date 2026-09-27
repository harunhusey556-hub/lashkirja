/**
 * One unsaved-changes guard for the whole app.
 *
 * Editors register while they are dirty. Back, tab changes, and an explicit
 * cancel ask once, in Finnish, before the navigation runs. A clean form never
 * interrupts.
 */
export const DISCARD_TITLE = "Hylätäänkö tallentamattomat muutokset?";
export const DISCARD_DESCRIPTION =
  "Tallentamattomat tiedot katoavat, jos jatkat tallentamatta.";

type DirtySource = () => boolean;

const sources = new Map<string, DirtySource>();
let leaveHandler: ((proceed: () => void) => void) | null = null;

export function registerDirtySource(id: string, isDirty: DirtySource): () => void {
  sources.set(id, isDirty);
  return () => {
    if (sources.get(id) === isDirty) sources.delete(id);
  };
}

export function anyFormDirty(): boolean {
  for (const isDirty of sources.values()) {
    if (isDirty()) return true;
  }
  return false;
}

export function setLeaveHandler(handler: ((proceed: () => void) => void) | null): void {
  leaveHandler = handler;
}

/** Run `proceed` now, or after the user confirms they want to drop edits. */
export function requestLeave(proceed: () => void): void {
  if (!anyFormDirty() || !leaveHandler) {
    proceed();
    return;
  }
  leaveHandler(proceed);
}

export function resetFormGuardForTests(): void {
  sources.clear();
  leaveHandler = null;
}
