"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRefetchOnReconnect } from "@/components/useRefetchOnReconnect";
import { isUnauthorized, redirectToLogin } from "@/components/clientFetch";
import { useCacheAfterBoot } from "@/components/invoices/useCacheAfterBoot";
import {
  pickCachedValue,
  readCached,
  refreshCached,
  storeCached,
  type FetchedValue,
} from "@/lib/cached-resource";

/**
 * A value that paints from the page cache on the first frame and refreshes
 * quietly (QUALITY-BAR N3, L1). Same pattern as Laskut/Raportit: a synchronous
 * cache read for a revisit, `useCacheAfterBoot` for a cold launch where the
 * persistent cache is hydrated after mount, and a write-through after every
 * successful fetch.
 *
 * - `value === null`: never seen and not loaded yet -> show a skeleton.
 * - `failed && value === null`: nothing to show and the fetch failed.
 * - a failed refresh with a value keeps that value (`failed` is still true so
 *   a screen may say the copy is old).
 *
 * `key: null` disables the fetch (for a value that depends on something not
 * known yet, e.g. the profile).
 */
export function useCachedResource<T>(
  key: string | null,
  load: (signal: AbortSignal) => Promise<T>
) {
  const [fetched, setFetched] = useState<FetchedValue<T> | null>(null);
  const [failure, setFailure] = useState<{ key: string; error: unknown } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });
  const late = useCacheAfterBoot<T>(key);

  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    void refreshCached(key, (signal) => loadRef.current(signal), controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.ok) {
        setFetched({ key, value: result.value });
        setFailure(null);
        return;
      }
      if (isUnauthorized(result.error)) {
        redirectToLogin();
        return;
      }
      setFailure({ key, error: result.error });
    });
    return () => controller.abort();
  }, [key, attempt]);

  const value = pickCachedValue(key, fetched, readCached<T>(key), late);
  const error = failure && failure.key === key ? failure.error : null;

  /** Local update after a mutation; also cached for the next visit. */
  const set = useCallback(
    (next: T) => {
      if (!key) return;
      storeCached(key, next);
      setFetched({ key, value: next });
    },
    [key]
  );
  const reload = useCallback(() => {
    setFailure(null);
    setAttempt((n) => n + 1);
  }, []);

  // The connection came back: an error card clears and a cached copy catches up (F32).
  useRefetchOnReconnect(reload);

  return { value, failed: error !== null, error, set, reload };
}
