/**
 * The mobile auth flow: password -> bearer token, kept in the Keychain (via
 * secure-store.ts) and mirrored in memory for the app's lifetime. On the web
 * build, signIn() still does the JSON cookie login phase 1 left in place;
 * everything else here (signOutThisDevice, expireSession,
 * refreshTokenIfDue, the pending-revoke retry) is mobile-only.
 *
 * Deliberately does NOT import auth-credential.ts or session-options.ts:
 * those pull in iron-session and throw at module load when SESSION_SECRET
 * is missing -- safe on the server, fatal if this file (imported by client
 * components) were ever bundled into client JS with them attached.
 */
import { apiUrl, IS_MOBILE_BUILD } from "@/lib/build-target";
import { appNavigate } from "@/lib/app-nav";
import { secureStore, SECURE_KEYS } from "@/lib/mobile/secure-store";
import { clearPageCache, configurePageCachePersistence } from "@/lib/page-cache";
import { clearAllDrafts } from "@/lib/draft-store";
import { wipePersistentCache } from "@/lib/offline/persistent-cache";
import { configureHttpCachePersistence } from "@/lib/offline/http-cache";
import { activatePersistentCache } from "@/lib/mobile/boot";
import { resetOfflineReceiptQueueForLogout } from "@/components/useOfflineReceiptQueue";

export interface StoredAuth {
  token: string;
  expiresAt: string;
  issuedAt: string;
  userId: string;
}

export type SignInResult =
  | { ok: true; user: { userId: string; email: string; firstName: string } }
  | { ok: false; status: number; error: string; retryAfter?: number };

/** Mirrors auth-credential.ts's TOKEN_REFRESH_AFTER_SECONDS. Duplicated
 * rather than imported -- see the file header. */
const TOKEN_REFRESH_AFTER_SECONDS = 7 * 24 * 60 * 60;
const LOGOUT_TIMEOUT_MS = 8_000;

let memoryAuth: StoredAuth | null = null;
/** expireSession's "once per signed-in period" guard: cleared by a fresh
 * signIn(), since that starts a new signed-in period. */
let expiredThisPeriod = false;
const listeners = new Set<(auth: StoredAuth | null) => void>();

function notifyListeners(auth: StoredAuth | null): void {
  for (const listener of listeners) listener(auth);
}

export function onAuthChange(listener: (auth: StoredAuth | null) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Sync, memory copy after boot -- callers on the hot path (clientFetch's
 * per-request header) must never await the secure store. */
export function getAccessToken(): string | null {
  return memoryAuth?.token ?? null;
}

async function persistAuth(auth: StoredAuth): Promise<void> {
  memoryAuth = auth;
  await secureStore().set(SECURE_KEYS.auth, JSON.stringify(auth));
}

export async function loadStoredAuth(): Promise<StoredAuth | null> {
  const raw = await secureStore().get(SECURE_KEYS.auth);
  if (!raw) {
    memoryAuth = null;
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<StoredAuth>;
    if (!parsed || typeof parsed.token !== "string" || typeof parsed.userId !== "string") {
      memoryAuth = null;
      return null;
    }
    memoryAuth = parsed as StoredAuth;
    return memoryAuth;
  } catch {
    memoryAuth = null;
    return null;
  }
}

function parseRetryAfter(response: Response): number | undefined {
  const raw = response.headers.get("Retry-After");
  const value = raw ? Number(raw) : NaN;
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

async function signInWeb(input: { email: string; password: string; next?: string }): Promise<SignInResult> {
  const response = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ email: input.email, password: input.password, next: input.next || "" }),
  });

  let body: { error?: string; user?: { firstName?: string; email?: string } } = {};
  try {
    body = await response.json();
  } catch {
    // No/invalid JSON body -- fall through to the status-based result.
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: body.error || "Kirjautuminen epäonnistui",
      retryAfter: parseRetryAfter(response),
    };
  }

  return {
    ok: true,
    // The web session lives in the cookie; nothing on the web build reads
    // this field back (mobile's BootResult.userId comes from the token
    // path instead).
    user: { userId: "", email: body.user?.email ?? input.email, firstName: body.user?.firstName ?? "" },
  };
}

async function signInMobile(input: { email: string; password: string }): Promise<SignInResult> {
  const response = await fetch(apiUrl("/api/auth/token"), {
    method: "POST",
    credentials: "omit",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: input.email, password: input.password, device: "ios-app" }),
  });

  let body: {
    error?: string;
    token?: string;
    expiresAt?: string;
    user?: { userId: string; email: string; firstName: string };
  } = {};
  try {
    body = await response.json();
  } catch {
    // No/invalid JSON body -- fall through to the status-based result.
  }

  if (!response.ok || !body.token || !body.user) {
    return {
      ok: false,
      status: response.status,
      error: body.error || "Kirjautuminen epäonnistui",
      retryAfter: parseRetryAfter(response),
    };
  }

  const stored: StoredAuth = {
    token: body.token,
    expiresAt: body.expiresAt ?? "",
    issuedAt: new Date().toISOString(),
    userId: body.user.userId,
  };
  await persistAuth(stored);
  // A fresh sign-in starts a new signed-in period: a future 401 deserves
  // its own redirect again.
  expiredThisPeriod = false;
  notifyListeners(stored);
  // Re-arms the persistent cache for this user. `bootMobile()` itself only
  // ever runs its own setup once per app launch, so a sign-in that is not
  // also a fresh launch (this same running session, after an earlier
  // sign-out) needs this called directly -- it is the same owner-check-and-
  // wipe logic `bootMobile()` uses, so a leftover different user's rows
  // (the app killed before a wipe finished) are still caught here.
  void activatePersistentCache(stored.userId, stored.token).catch(() => {});
  return { ok: true, user: body.user };
}

export async function signIn(input: { email: string; password: string; next?: string }): Promise<SignInResult> {
  return IS_MOBILE_BUILD ? signInMobile(input) : signInWeb(input);
}

async function postLogout(token: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOGOUT_TIMEOUT_MS);
  try {
    const response = await fetch(apiUrl("/api/auth/logout"), {
      method: "POST",
      credentials: "omit",
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function clearClientAuthState(): Promise<void> {
  memoryAuth = null;
  await secureStore().remove(SECURE_KEYS.auth);
  clearPageCache();
  clearAllDrafts();
  // Crypto-shred: every persisted row gone and the cache's own AES-GCM key
  // deleted, then both page-cache.ts and http-cache.ts un-configured so
  // nothing keeps writing to a store that no longer has a key.
  await wipePersistentCache();
  configurePageCachePersistence(null);
  configureHttpCachePersistence(null);
  // Task 10: the offline receipt queue is cleared alongside the cache --
  // any photo still waiting to send is lost with the rest of this device's
  // signed-in state (the profile sheet's logout confirmation warns about
  // this first when the queue is non-empty).
  await resetOfflineReceiptQueueForLogout();
  notifyListeners(null);
}

/** Mobile logout. Whatever the server call's outcome, every client-visible
 * trace of the session is cleared -- a failed call is not evidence the
 * session is still good. A failed call's token is kept under pendingRevoke
 * so the same logout is retried later (see retryPendingRevoke). */
export async function signOutThisDevice(): Promise<boolean> {
  const stored = memoryAuth ?? (await loadStoredAuth());
  let ok = false;
  if (stored) {
    ok = await postLogout(stored.token);
    if (!ok) await secureStore().set(SECURE_KEYS.pendingRevoke, stored.token);
  }
  await clearClientAuthState();
  return ok;
}

/** Retries a logout call that failed earlier (network drop, server
 * unreachable) for a token already removed from active use. Called on the
 * next successful API request and at app launch (bootMobile). A no-op when
 * nothing is pending. */
export async function retryPendingRevoke(): Promise<void> {
  const pending = await secureStore().get(SECURE_KEYS.pendingRevoke);
  if (!pending) return;
  const ok = await postLogout(pending);
  if (ok) await secureStore().remove(SECURE_KEYS.pendingRevoke);
}

/** Mobile 401 path. Once per signed-in period (reset by the next signIn):
 * clears everything like a logout, but with no server call -- the server
 * already considers this token gone. */
export function expireSession(): void {
  if (expiredThisPeriod) return;
  expiredThisPeriod = true;
  void clearClientAuthState();
  appNavigate("/login?error=expired", { replace: true });
}

/**
 * Proactively refreshes a token older than TOKEN_REFRESH_AFTER_SECONDS.
 * The server does not enforce this timing -- an unexpired token still works
 * on its own -- so a network error here just keeps the old token; only a
 * definitive 401 (the session row itself is gone) ends it.
 */
export async function refreshTokenIfDue(now: number = Date.now()): Promise<void> {
  if (!memoryAuth) return;
  const issuedAt = new Date(memoryAuth.issuedAt).getTime();
  if (!Number.isFinite(issuedAt) || now - issuedAt <= TOKEN_REFRESH_AFTER_SECONDS * 1000) return;

  const token = memoryAuth.token;
  try {
    const response = await fetch(apiUrl("/api/auth/token/refresh"), {
      method: "POST",
      credentials: "omit",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.status === 401) {
      expireSession();
      return;
    }
    if (!response.ok) return;
    const body = (await response.json()) as { token?: string; expiresAt?: string; user?: { userId: string } };
    if (!body.token) return;
    await persistAuth({
      token: body.token,
      expiresAt: body.expiresAt ?? memoryAuth.expiresAt,
      issuedAt: new Date().toISOString(),
      userId: body.user?.userId ?? memoryAuth.userId,
    });
  } catch {
    // Network error: keep the old token, it is still valid up to its own
    // TTL. The next call to refreshTokenIfDue tries again.
  }
}
