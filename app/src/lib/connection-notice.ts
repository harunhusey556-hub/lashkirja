"use client";

/**
 * Which surface owns a connection problem on the current screen (VS-32, TF-21, FP-14).
 *
 * A page-level card (`ConnectionNotice` when the load failed, `StaleBanner` when a
 * cached copy is on screen) already says "no connection" and offers ONE retry. While
 * one is mounted the global `ConnectivityBanner` stays quiet, so a screen never shows
 * two messages, two retry buttons, or a banner that claims cached data above an
 * empty error card.
 */
import { useSyncExternalStore } from "react";

let owners = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Called while a page-level connection card is mounted; returns the release. */
export function claimConnectionNotice(): () => void {
  owners += 1;
  emit();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    owners -= 1;
    emit();
  };
}

/** How many page cards own the message right now (for tests). */
export function connectionNoticeClaims(): number {
  return owners;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** True while a page-level card owns the connection message. */
export function useConnectionNoticeClaimed(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => owners > 0,
    () => false
  );
}
