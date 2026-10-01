"use client";

import { useEffect, useRef } from "react";

/** Waits for the session refresh (SessionProvider listens to the same event) to go first. */
export const RECONNECT_REFETCH_DELAY_MS = 400;

/**
 * Runs `callback` once, shortly after `lashkirja-reconnected` fires on
 * `target`, however many events arrive in a burst. Returns the unsubscribe.
 * Split from the hook so it can be tested without a DOM.
 */
export function onReconnectDebounced(
  target: Pick<EventTarget, "addEventListener" | "removeEventListener">,
  callback: () => void,
  delayMs: number = RECONNECT_REFETCH_DELAY_MS
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const handler = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      callback();
    }, delayMs);
  };
  target.addEventListener("lashkirja-reconnected", handler);
  return () => {
    target.removeEventListener("lashkirja-reconnected", handler);
    if (timer !== null) clearTimeout(timer);
  };
}

/**
 * A screen refetches by itself when the connection returns (F32): the error
 * card clears and a list that was served from the cache catches up, while the
 * screen stays mounted with its form state. `reload` is the screen's own
 * retry; the latest one is always used.
 */
export function useRefetchOnReconnect(reload: () => void): void {
  const reloadRef = useRef(reload);
  useEffect(() => {
    reloadRef.current = reload;
  });
  useEffect(() => onReconnectDebounced(document, () => reloadRef.current()), []);
}
