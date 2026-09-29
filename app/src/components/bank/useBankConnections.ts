"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch, isUnauthorized, readJson, redirectToLogin } from "@/components/clientFetch";
import { readPageCache, writePageCache } from "@/lib/page-cache";
import { useCacheAfterBoot } from "@/components/invoices/useCacheAfterBoot";
import type { BankConnectionSummary, BankConnectionsPayload } from "@/lib/bank-status";

const CACHE_KEY = "bank-connections";

function normalize(raw: Partial<BankConnectionsPayload> & { message?: unknown }): BankConnectionsPayload {
  // `message` is dropped on purpose: it can carry setting names (L5).
  return {
    enabled: Boolean(raw.enabled),
    ready: Boolean(raw.ready),
    connections: Array.isArray(raw.connections) ? raw.connections : [],
  };
}

/**
 * `GET /api/bank/connections` for the hub row and the connect cards. A cached
 * copy paints at once (N3); the fetch that always follows replaces it. A
 * failed fetch with nothing cached is `error`, never a fake "not connected".
 */
export function useBankConnections() {
  const [fetched, setData] = useState<BankConnectionsPayload | null>(() => {
    const cached = readPageCache<BankConnectionsPayload>(CACHE_KEY);
    return cached ? normalize(cached) : null;
  });
  // Cold launch: the cache hydrates after this hook first ran, so the copy from
  // the last session paints once it is readable, not after the round trip (N3).
  const late = useCacheAfterBoot<BankConnectionsPayload>(CACHE_KEY);
  const lateNormalized = useMemo(() => (late ? normalize(late) : null), [late]);
  const data = fetched ?? lateNormalized;
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    apiFetch("/api/bank/connections", { signal: controller.signal })
      .then((response) => readJson<BankConnectionsPayload>(response, "Pankkiyhteyden haku epäonnistui"))
      .then((raw) => {
        if (controller.signal.aborted) return;
        const next = normalize(raw);
        writePageCache(CACHE_KEY, next);
        setData(next);
        setError(null);
      })
      .catch((loadError: unknown) => {
        if (controller.signal.aborted) return;
        if (isUnauthorized(loadError)) {
          redirectToLogin();
          return;
        }
        setError(loadError);
      });
    return () => controller.abort();
  }, [attempt]);

  const reload = useCallback(() => {
    setError(null);
    setAttempt((value) => value + 1);
  }, []);

  /** Local update after a mutation (scope toggle, disconnect), cached too. */
  const updateConnections = useCallback(
    (update: (connections: BankConnectionSummary[]) => BankConnectionSummary[]) => {
      setData((fetchedNow) => {
        const current = fetchedNow ?? lateNormalized;
        if (!current) return fetchedNow;
        const next = { ...current, connections: update(current.connections) };
        writePageCache(CACHE_KEY, next);
        return next;
      });
    },
    [lateNormalized]
  );

  return { data, error, loading: data === null && error === null, reload, updateConnections };
}
