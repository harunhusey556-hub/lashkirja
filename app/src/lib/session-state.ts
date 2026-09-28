/**
 * Pure session logic shared by every consumer of SessionProvider: the
 * initial state before the first `/api/auth/me` response, the transitions
 * on that response's outcome, and a shared in-flight promise so concurrent
 * callers (the mount effect and a `visibilitychange` firing close together)
 * never issue two requests. No fetch, no React, no module-load side effect
 * beyond the tiny in-flight cache below -- kept here, not in
 * SessionProvider.tsx, so it can be unit-tested with no DOM and no mocking
 * of clientFetch.ts.
 *
 * `isMobile` is a parameter, not a read of IS_MOBILE_BUILD, for the same
 * reason `mobileApiRequest` in clientFetch.ts takes its token as a
 * parameter: IS_MOBILE_BUILD is a build-time constant baked into the
 * bundle, so it cannot be flipped per test. SessionProvider.tsx calls
 * `initialSessionState(cachedUser)` with no second argument and gets the
 * real build constant as the default.
 */
import { IS_MOBILE_BUILD } from "@/lib/build-target";

export type SessionStatus = "unknown" | "signed-in" | "signed-out";

export interface ShellUser {
  userId?: string;
  email?: string;
  firstName?: string;
}

export interface SessionState {
  status: SessionStatus;
  user: ShellUser | null;
}

/** The page-cache key the session's last-known user is written under and
 * read from on the very first render (see page-cache.ts). */
export const SESSION_CACHE_KEY = "shell-auth";

/**
 * Before any network response: the web proxy already refused to serve a
 * protected page to a cookie it could not unseal, so a page that rendered
 * at all belongs to a signed-in user -- "signed-in" here, confirmed for
 * real by the first `/me` call. Mobile has no such server gate (the app
 * shell is a static file); its session is unknown until `bootMobile()`'s
 * local Keychain read resolves, so it starts "unknown" -- which still
 * renders children immediately (see `applyMeOutcome`/A1: only
 * "signed-out" blocks rendering).
 */
export function initialSessionState(
  cachedUser: ShellUser | null,
  isMobile: boolean = IS_MOBILE_BUILD
): SessionState {
  return { status: isMobile ? "unknown" : "signed-in", user: cachedUser };
}

/**
 * `bootMobile()`'s local, no-network verdict: is there a stored token at
 * all. A token gives an optimistic "signed-in" (still to be confirmed by
 * `/me`, which corrects it on an actual 401); no token skips the network
 * round trip entirely and goes straight to "signed-out".
 */
export function applyBootOutcome(state: SessionState, signedIn: boolean): SessionState {
  if (signedIn) return { ...state, status: "signed-in" };
  return { status: "signed-out", user: null };
}

export type MeOutcome =
  | { kind: "ok"; user: ShellUser }
  | { kind: "unauthorized" }
  | { kind: "network-error" };

/**
 * 200 -> signed-in with the fresh user. 401 -> signed-out, user cleared
 * (the caller redirects). A network error keeps the current state exactly
 * as it was -- a flaky connection must not blank an already-rendered page.
 */
export function applyMeOutcome(state: SessionState, outcome: MeOutcome): SessionState {
  if (outcome.kind === "ok") return { status: "signed-in", user: outcome.user };
  if (outcome.kind === "unauthorized") return { status: "signed-out", user: null };
  return state;
}

let inflightMe: Promise<MeOutcome> | null = null;

/**
 * Runs `fetcher` at most once per outstanding call. A second caller while
 * the first is still in flight (the mount effect and a `visibilitychange`
 * dispatched in the same tick, or two mounted consumers) receives the same
 * promise instead of starting a second `/me` request. Once it settles, the
 * next call starts a fresh one.
 */
export function sharedMeFetch(fetcher: () => Promise<MeOutcome>): Promise<MeOutcome> {
  if (!inflightMe) {
    inflightMe = fetcher().finally(() => {
      inflightMe = null;
    });
  }
  return inflightMe;
}

export function resetSessionStateForTests(): void {
  inflightMe = null;
}
