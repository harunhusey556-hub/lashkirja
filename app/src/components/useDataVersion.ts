"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { apiFetch, readJson } from "@/components/clientFetch";
import {
  getDataVersion,
  startVersionPolling,
  subscribeDataVersion,
  type SyncVersionPayload,
} from "@/lib/client-data-version";

/** Subscribers share one poller: it starts with the first screen and stops with the last. */
let pollerUsers = 0;
let stopPoller: (() => void) | null = null;
/** The server has no `/api/sync/version` (older deploy): bumps still work, polling stays off. */
let pollingUnsupported = false;

async function fetchVersion(): Promise<SyncVersionPayload | null> {
  try {
    const response = await apiFetch("/api/sync/version", { credentials: "include", cache: "no-store" });
    if (response.status === 404) {
      pollingUnsupported = true;
      stopPoller?.();
      stopPoller = null;
      return null;
    }
    return await readJson<SyncVersionPayload>(response, "Päivitystietojen haku epäonnistui");
  } catch {
    // A 401 is the session layer's business and being offline is the connectivity banner's.
    return null;
  }
}

function acquirePoller(): () => void {
  pollerUsers += 1;
  if (pollerUsers === 1 && !pollingUnsupported && typeof document !== "undefined") {
    stopPoller = startVersionPolling({
      fetchVersion,
      isVisible: () => document.visibilityState !== "hidden",
      onVisible: (callback) => {
        document.addEventListener("visibilitychange", callback);
        return () => document.removeEventListener("visibilitychange", callback);
      },
    });
  }
  return () => {
    pollerUsers -= 1;
    if (pollerUsers === 0) {
      stopPoller?.();
      stopPoller = null;
    }
  };
}

function subscribe(listener: () => void): () => void {
  const release = acquirePoller();
  const unsubscribe = subscribeDataVersion(listener);
  return () => {
    unsubscribe();
    release();
  };
}

/**
 * The current data version. It changes when a sync, import or save happened
 * (here, on another device, or in the background), so an effect that lists it
 * as a dependency refetches. Prefer `useRefetchOnDataVersion` for the usual
 * "run my reload" case.
 */
export function useDataVersion(): number {
  return useSyncExternalStore(subscribe, getDataVersion, () => 0);
}

/**
 * Runs `reload` whenever the data version moves after this screen mounted,
 * never on mount (the screen has just fetched). The latest `reload` is used.
 */
export function useRefetchOnDataVersion(reload: () => void): void {
  const version = useDataVersion();
  const seen = useRef(version);
  const reloadRef = useRef(reload);
  useEffect(() => {
    reloadRef.current = reload;
  });
  useEffect(() => {
    if (seen.current === version) return;
    seen.current = version;
    reloadRef.current();
  }, [version]);
}
