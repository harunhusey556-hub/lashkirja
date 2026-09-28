"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import {
  applyBootOutcome,
  applyMeOutcome,
  initialSessionState,
  sharedMeFetch,
  SESSION_CACHE_KEY,
  type MeOutcome,
  type SessionState,
  type SessionStatus,
  type ShellUser,
} from "@/lib/session-state";
import { apiFetch, isUnauthorized, readJson, redirectToLogin } from "@/components/clientFetch";
import { readPageCache, writePageCache } from "@/lib/page-cache";
import { IS_MOBILE_BUILD } from "@/lib/build-target";
import { bootMobile } from "@/lib/mobile/boot";
import { getAccessToken } from "@/lib/auth-client";
import { syncPageHiddenFlag } from "@/lib/page-activity";
import { setDraftOwner } from "@/lib/draft-store";

export type { SessionStatus, ShellUser } from "@/lib/session-state";

export interface SessionValue {
  status: SessionStatus;
  user: ShellUser | null;
  /** One shared GET /api/auth/me; concurrent callers share the promise. */
  refresh(): Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

async function fetchMeOutcome(): Promise<MeOutcome> {
  try {
    const response = await apiFetch("/api/auth/me", { credentials: "include" });
    const data = await readJson<{ user: ShellUser | null }>(response, "Istunnon tarkistus epäonnistui");
    return { kind: "ok", user: data.user ?? {} };
  } catch (error) {
    if (isUnauthorized(error)) return { kind: "unauthorized" };
    return { kind: "network-error" };
  }
}

/**
 * The one session source for the signed-in app (mounted by ShellGate around
 * AppShell -- never for the bare routes, which do their own boot check).
 * Renders nothing itself; consumers read `useSession()`.
 */
export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<SessionState>(() =>
    initialSessionState(readPageCache<ShellUser>(SESSION_CACHE_KEY))
  );

  const refresh = useCallback(async () => {
    const outcome = await sharedMeFetch(fetchMeOutcome);
    if (outcome.kind === "unauthorized") {
      setState((previous) => applyMeOutcome(previous, outcome));
      redirectToLogin();
      return;
    }
    setState((previous) => {
      const next = applyMeOutcome(previous, outcome);
      if (outcome.kind === "ok") writePageCache(SESSION_CACHE_KEY, next.user);
      return next;
    });
  }, []);

  // Mount: mobile has a local, no-network verdict (a stored token or not)
  // before the first network round trip -- skip straight to signed-out
  // when there plainly is none, otherwise confirm with /me like the web
  // target always does.
  //
  // `bootMobile()` itself is only awaited here as a synchronization
  // barrier (has the Keychain read happened yet) -- exactly like
  // clientFetch.ts already does before every mobile request. Its own
  // *resolved* `signedIn` field is memoized for the whole app launch and
  // goes stale the moment a sign-in happens without a document reload (a
  // client-side login landing on a protected route, in this same SPA
  // session): branching on it here caused the freshly-logged-in page to
  // read the pre-login "no token" verdict and bounce straight back to
  // /login. `getAccessToken()` is read fresh, after the barrier, so it
  // always reflects the live Keychain-backed token instead.
  useEffect(() => {
    let cancelled = false;
    async function boot() {
      if (IS_MOBILE_BUILD) {
        await bootMobile();
        if (cancelled) return;
        if (!getAccessToken()) {
          setState((previous) => applyBootOutcome(previous, false));
          redirectToLogin();
          return;
        }
        setState((previous) => applyBootOutcome(previous, true));
      }
      if (!cancelled) await refresh();
    }
    void boot();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  // Foreground resume: the JS context normally survives backgrounding, so
  // this is a quiet best-effort revalidation -- only a real 401 (session
  // expired/revoked while backgrounded) changes anything visible.
  useEffect(() => {
    const onVisibility = () => {
      const hidden = document.visibilityState === "hidden";
      syncPageHiddenFlag(hidden);
      if (hidden) return;
      void refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [refresh]);

  const userId = state.user?.userId ?? null;
  useEffect(() => {
    setDraftOwner(userId);
  }, [userId]);

  const value: SessionValue = {
    status: state.status,
    user: state.user,
    refresh,
  };

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const context = useContext(SessionContext);
  if (!context) {
    throw new Error("useSession must be used within SessionProvider");
  }
  return context;
}
