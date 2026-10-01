import { clearAllDrafts } from "@/lib/draft-store";
import { clearPageCache, invalidateForMutation } from "@/lib/page-cache";
import { logoutOutcome } from "@/lib/session-policy";
import { apiUrl, IS_MOBILE_BUILD } from "@/lib/build-target";
import { appNavigate } from "@/lib/app-nav";
import { expireSession, getAccessToken, retryPendingRevoke, signOutThisDevice } from "@/lib/auth-client";
import { bootMobile } from "@/lib/mobile/boot";
import { rememberGet, staleResponseFor } from "@/lib/offline/http-cache";
import { assertCanWrite, isGatewayStatus, reportRequestOutcome } from "@/lib/connectivity";

export class ApiError extends Error {
  status: number;
  details?: unknown;

  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
  }
}

type ErrorPayload = { error?: { message?: string; details?: unknown } | string } | null;

export async function readJson<T>(
  response: Response,
  fallbackMessage: string
): Promise<T> {
  const payload = (await response.json().catch(() => null)) as ErrorPayload | T;

  if (!response.ok) {
    let message = fallbackMessage;
    let details: unknown = undefined;
    
    if (payload && typeof payload === "object" && "error" in payload) {
      if (typeof payload.error === "string") {
        message = payload.error;
        const rest = { ...(payload as Record<string, unknown>) };
        delete rest.error;
        if (Object.keys(rest).length > 0) details = rest;
      } else if (payload.error && typeof payload.error === "object") {
        message = payload.error.message || fallbackMessage;
        details = payload.error.details;
      }
    }
    
    throw new ApiError(message, response.status, details);
  }

  if (payload === null) {
    throw new ApiError(fallbackMessage, response.status);
  }

  return payload as T;
}

const REQUEST_TIMEOUT_MS = 25_000;
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD"]);

/** A request that never got a response — hung connection, not a transient 5xx. */
export class ApiTimeoutError extends Error {
  constructor() {
    super("Pyyntö aikakatkaistiin. Tarkista verkkoyhteytesi ja yritä uudelleen.");
    this.name = "ApiTimeoutError";
  }
}

/** A 502/503/504 from the gateway/proxy, not from the app's own logic. */
export class ApiGatewayError extends Error {
  status: number;
  constructor(status: number) {
    super(
      "Palvelin ei vastannut hetkeen. Tarkista onnistuiko toiminto ennen kuin yrität uudelleen."
    );
    this.name = "ApiGatewayError";
    this.status = status;
  }
}

export type ApiFetchInit = RequestInit & {
  timeoutMs?: number;
  /** Skips the fail-fast `assertCanWrite()` check for a non-GET request --
   * Task 10's offline receipt queue, which is meant to accept a write
   * while offline and send it later. */
  offlineQueue?: boolean;
};

/**
 * Pure: computes the URL and RequestInit actually sent for a possible
 * mobile /api/* call. Exported so unit tests can exercise the header-merge
 * and credentials rules directly, without needing to flip IS_MOBILE_BUILD
 * (a build-time constant baked in at module load) at test time.
 *
 * `new Headers(init)` already accepts a plain object, a Headers instance,
 * or an array of [key, value] pairs -- whatever shape the caller passed --
 * so the merge itself needs no per-shape handling.
 */
export function mobileApiRequest(
  path: string,
  init: RequestInit,
  token: string | null
): { url: string; init: RequestInit } {
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return { url: apiUrl(path), init: { ...init, credentials: "omit", headers } };
}

function isMobileApiPath(input: RequestInfo | URL): input is string {
  return typeof input === "string" && input.startsWith("/api/");
}

/** Aborts when either the caller's own signal or our timeout fires, whichever comes first. */
function withTimeout(externalSignal: AbortSignal | null | undefined, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  externalSignal?.addEventListener("abort", onExternalAbort);
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    },
  };
}

/**
 * Resilient fetch wrapper with extreme exponential backoff for network drops
 * & transient 5xx faults, plus an absolute timeout so a hung connection
 * doesn't spin forever with no feedback.
 *
 * Retries are limited to safe (GET/HEAD) requests: a lost response to a
 * non-idempotent POST/PUT/PATCH/DELETE on a gateway timeout could otherwise
 * mean the request actually succeeded server-side and this would silently
 * resubmit it, risking a duplicate record. Those methods get one attempt —
 * the caller's existing retry/error UI handles the rest.
 */
const inflightGets = new Map<string, Promise<Response>>();

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * Collapse identical in-flight GETs (tab warm-up plus the page that just
 * opened, or two screens asking for the same list) into one network call.
 * Each caller receives its own clone so the body can be read twice.
 * A caller-supplied abort signal opts out: that request has its own lifetime.
 */
export async function apiFetch(input: RequestInfo | URL, init?: ApiFetchInit): Promise<Response> {
  const method = (init?.method || "GET").toUpperCase();
  // Fail fast: no network attempt at all for a write with no path to the
  // server -- a thrown OfflineError surfaces through the caller's existing
  // catch/errorMessage() with no per-page change (Task 8).
  if (!IDEMPOTENT_METHODS.has(method) && !init?.offlineQueue) {
    assertCanWrite();
  }
  const shareable = IDEMPOTENT_METHODS.has(method) && !init?.signal;
  const key = shareable ? `${method} ${requestUrl(input)}` : null;
  if (key) {
    const existing = inflightGets.get(key);
    if (existing) return existing.then((response) => response.clone());
  }

  const promise = apiFetchAttempt(input, init);
  if (key) {
    inflightGets.set(key, promise);
    // `.finally` creates a second rejection the caller does not await.
    void promise.finally(() => {
      if (inflightGets.get(key) === promise) inflightGets.delete(key);
    }).catch(() => undefined);
    return promise.then((response) => response.clone());
  }
  return promise;
}

/**
 * A previously-remembered GET response, only ever offered up once the live
 * network attempt has definitively failed (a thrown error, or every retry
 * exhausted) -- never a substitute for a request that might still succeed.
 * Mobile only; a no-op (returns null) on the web or for a non-idempotent
 * method, where serving a stale write response would be actively wrong.
 */
async function staleFallback(url: RequestInfo | URL, method: string): Promise<Response | null> {
  if (!IS_MOBILE_BUILD || !IDEMPOTENT_METHODS.has(method)) return null;
  try {
    return await staleResponseFor(requestUrl(url));
  } catch {
    return null;
  }
}

/** `proxy.ts` sets this on every response (`X-LashKirja-Api-Version`). */
function apiVersionFromHeader(response: Response): number | null {
  const raw = response.headers.get("X-LashKirja-Api-Version");
  if (!raw) return null;
  const version = Number(raw);
  return Number.isFinite(version) ? version : null;
}

async function apiFetchAttempt(input: RequestInfo | URL, init?: ApiFetchInit): Promise<Response> {
  const method = (init?.method || "GET").toUpperCase();
  const maxRetries = IDEMPOTENT_METHODS.has(method) ? 3 : 1;
  const timeoutMs = init?.timeoutMs ?? REQUEST_TIMEOUT_MS;
  let rest: RequestInit = { ...(init ?? {}) };
  delete (rest as ApiFetchInit).timeoutMs;
  delete (rest as ApiFetchInit).offlineQueue;

  // Mobile: every relative /api/* call actually goes to the configured API
  // origin, with no cookies and a Bearer header instead. Computed once, up
  // front, so every retry attempt below reuses the same rewritten request.
  // Web behaviour is untouched -- IS_MOBILE_BUILD is false there, so this
  // branch never runs and `input`/`rest` pass through exactly as given.
  if (IS_MOBILE_BUILD && isMobileApiPath(input)) {
    // Awaiting the (memoized) boot promise here -- not just from
    // BootRedirect on "/" -- is what makes a reload on any other page
    // (AppShell's own /api/auth/me check, e.g.) still find the token: a
    // fresh page load starts with no auth in memory until this resolves,
    // and this is the first place that would otherwise read it too early.
    // A no-op await after the first call of the page's lifetime.
    await bootMobile();
    const rewritten = mobileApiRequest(input, rest, getAccessToken());
    input = rewritten.url;
    rest = rewritten.init;
  }
  let attempt = 0;

  while (attempt < maxRetries) {
    const { signal, cleanup } = withTimeout(rest.signal, timeoutMs);
    try {
      const response = await fetch(input, { ...rest, signal });
      // If it's a 502/503/504 gateway/timeout error, we should retry!
      if (isGatewayStatus(response.status)) {
        throw new ApiGatewayError(response.status);
      }
      // Connectivity (Task 8): any other HTTP response means the server
      // was reached, whatever its status -- a 4xx business error is still
      // "ok" here. The version header is on every proxy response.
      reportRequestOutcome("ok", apiVersionFromHeader(response));
      if (response.ok && !IDEMPOTENT_METHODS.has(method)) {
        invalidateForMutation(requestUrl(input));
      }
      // Mobile GET fallback cache (Task 7): fire-and-forget, never delays
      // or fails this response. rememberGet's own isCacheableGet check
      // filters out everything that should not be kept.
      if (IS_MOBILE_BUILD && IDEMPOTENT_METHODS.has(method) && response.ok) {
        void rememberGet(requestUrl(input), response.clone()).catch(() => {});
      }
      // Retry point for a mobile logout whose server call failed earlier
      // (auth-client.ts's pendingRevoke). Fire-and-forget: never delays or
      // fails this response.
      if (IS_MOBILE_BUILD && response.ok) void retryPendingRevoke();
      return response; // 2xx, 4xx, and 500 (logic errors) are returned normally
    } catch (error) {
      if (rest.signal?.aborted) throw error; // caller cancelled — not a timeout, not retryable
      // Connectivity (Task 8): a gateway 502/503/504 (thrown above), our
      // own timeout abort, or fetch() itself throwing (DNS/TLS/offline) --
      // every path into this catch, except a caller cancelling, is a real
      // network-error outcome.
      reportRequestOutcome("network-error");
      if (
        error instanceof DOMException &&
        error.name === "AbortError"
      ) {
        const stale = await staleFallback(input, method);
        if (stale) return stale;
        throw new ApiTimeoutError();
      }
      attempt++;
      if (attempt >= maxRetries) {
        const stale = await staleFallback(input, method);
        if (stale) return stale;
        throw error; // Bubble up if maximum retries reached
      }
      // Wait exponentially: 500ms, 1000ms, 2000ms...
      await new Promise(resolve => setTimeout(resolve, 500 * Math.pow(2, attempt - 1)));
    } finally {
      cleanup();
    }
  }

  throw new Error("apiFetch failed unexpectedly");
}

/**
 * Same URL rewrite and header rule as apiFetch, but with no retry and no
 * absolute timeout -- for the AI chat's streamed response, where a retried
 * POST could resubmit a half-finished chat turn and an abort timer would
 * truncate a response that is simply still streaming.
 */
export async function authorizedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (IS_MOBILE_BUILD && isMobileApiPath(input)) {
    await bootMobile(); // see apiFetchAttempt's comment: a no-op after the page's first call.
    const rewritten = mobileApiRequest(input, init ?? {}, getAccessToken());
    return fetch(rewritten.url, rewritten.init);
  }
  return fetch(input, init);
}

export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

/** Finnish copy for a failure the user cannot read anything useful from. */
export const ERROR_COPY = {
  offline: "Ei verkkoyhteyttä. Tarkista yhteys ja yritä uudelleen.",
  unreachable: "Palvelimeen ei saada yhteyttä. Yritä hetken kuluttua uudelleen.",
  server: "Palvelimella tapahtui virhe. Yritä hetken kuluttua uudelleen.",
  expired: "Istunto vanheni. Kirjaudu sisään uudelleen.",
  forbidden: "Sinulla ei ole oikeutta tähän toimintoon.",
  notFound: "Tietoa ei löytynyt. Se on ehkä poistettu.",
  tooLarge: "Tiedosto on liian suuri.",
  rateLimited: "Liian monta yritystä. Odota hetki ja yritä uudelleen.",
} as const;

/**
 * The messages engines put on a fetch that got no response at all:
 * - Chromium: "Failed to fetch"
 * - Firefox: "NetworkError when attempting to fetch resource."
 * - WebKit: "Load failed", or the NSURLError text on iOS ("The network
 *   connection was lost.", "The Internet connection appears to be offline.",
 *   "Could not connect to the server.", "A server with the specified hostname
 *   could not be found.", "The request timed out.")
 * - React Native / polyfills: "Network request failed"
 */
const NETWORK_FAILURE =
  /failed to fetch|networkerror when attempting to fetch|load failed|network request failed|the network connection was lost|internet connection appears to be offline|could not connect to the server|hostname could not be found|the request timed out/i;

/**
 * No response at all. Only the known network messages count: a TypeError from
 * a code bug ("Cannot read properties of undefined") must surface as a bug,
 * not as "Palvelimeen ei saada yhteyttä".
 */
export function isNetworkFailure(error: unknown): boolean {
  return error instanceof Error && NETWORK_FAILURE.test(error.message.trim());
}

// Word boundaries are spelled (?<![A-Za-z]) / (?![A-Za-z]) on purpose: ASCII
// only, so a Finnish word such as "noin" or "ääni" never matches.
const INTERNAL_WORDS =
  /prisma|internal|exception|stack|undefined|(?<![A-Za-z])(null|nan)(?![A-Za-z])|econn|enotfound|etimedout|epipe|sqlite|constraint|unexpected token|json|syntaxerror|typeerror|referenceerror|https?:[/][/]/i;
const INTERNAL_SHAPES =
  /(?<![A-Za-z])P[0-9]{4}(?![0-9])|at [^ ]+ [(]|[a-z][A-Z][a-z]+[A-Z]|[A-Z]{2,}_[A-Z_]+/;
const ENGLISH_WORDS =
  /(?<![A-Za-z])(the|is|are|was|not|no|invalid|required|failed|fail|unable|cannot|can't|must|missing|expected|received|found|unauthorized|forbidden|too|already|error|server|request|response|string|number|object|please|try|again)(?![A-Za-z])/i;

/**
 * True when `message` is written for the user: Finnish, short, and free of
 * exception names, codes, stack frames, URLs and English framework text.
 * The server's own Finnish validation messages pass; "PrismaClient...",
 * "Internal error: P2002", "fail", "Load failed" and Zod's English do not.
 */
export function isUserFacingMessage(message: string): boolean {
  const text = message.trim();
  if (!text || text.length > 300) return false;
  if (INTERNAL_WORDS.test(text) || INTERNAL_SHAPES.test(text)) return false;
  if (ENGLISH_WORDS.test(text)) return false;
  return true;
}

function statusCopy(status: number): string | null {
  if (status === 401) return ERROR_COPY.expired;
  if (status === 403) return ERROR_COPY.forbidden;
  if (status === 404) return ERROR_COPY.notFound;
  if (status === 413) return ERROR_COPY.tooLarge;
  if (status === 429) return ERROR_COPY.rateLimited;
  if (status >= 500) return ERROR_COPY.server;
  return null;
}

function detailText(details: unknown): string | null {
  if (!Array.isArray(details)) return null;
  const parts = details
    .map((issue) =>
      issue && typeof issue === "object" && "message" in issue
        ? String((issue as { message?: unknown }).message ?? "")
        : String(issue ?? "")
    )
    .filter((part) => isUserFacingMessage(part));
  return parts.length > 0 ? parts.join(", ") : null;
}

function userMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiTimeoutError) return error.message;
  if (error instanceof ApiGatewayError) return error.message;
  if (isNetworkFailure(error)) {
    const offline = typeof navigator !== "undefined" && navigator.onLine === false;
    return offline ? ERROR_COPY.offline : ERROR_COPY.unreachable;
  }
  if (error instanceof ApiError) {
    const own = isUserFacingMessage(error.message) ? error.message : null;
    if (own) {
      const details = detailText(error.details);
      return details ? `${own}: ${details}` : own;
    }
    return statusCopy(error.status) ?? fallback;
  }
  if (error instanceof Error && isUserFacingMessage(error.message)) return error.message;
  return fallback;
}

/**
 * The one way to turn a failure into text for the user (AUTH-09, BOOKS-15,
 * SALES-18). Always Finnish: status codes and network failures map to fixed
 * copy, a server message is shown only when it is written for the user, and
 * anything raw goes to the console instead of the screen.
 */
export function errorMessage(error: unknown, fallback: string): string {
  const message = userMessage(error, fallback);
  const raw = error instanceof Error ? error.message : String(error ?? "");
  if (raw && raw !== message && typeof console !== "undefined") {
    console.warn("[LashKirja] virhe:", error);
  }
  return message;
}

/**
 * Used whenever an API call comes back 401 mid-session (cookie expired or was
 * cleared server-side). Carries a reason so the login screen can explain why
 * the user landed there instead of silently dropping them on a blank form.
 *
 * Guarded to one redirect per page lifetime: several widgets can each get a
 * 401 back from the same dead session within one tick (a batch of parallel
 * fetches all failing together), and without the guard each of them would
 * call `location.replace` — harmless individually, but it turns "navigate
 * once" into a redirect storm the browser has to unwind.
 *
 * Mobile has no page lifetime to guard on -- there is no document reload,
 * ever, so this module's state outlives many logins and logouts. It
 * delegates entirely to auth-client's expireSession(), whose own "once per
 * signed-in period" guard resets on the next signIn().
 */
let redirectingToLogin = false;
export function redirectToLogin(): void {
  if (IS_MOBILE_BUILD) {
    void expireSession();
    return;
  }
  if (redirectingToLogin) return;
  redirectingToLogin = true;
  window.location.replace("/login?error=expired");
}

/**
 * Ends the server session. Returns false when the server call failed, but
 * either way clears every client-visible trace of the session — cached
 * pages and drafts — since a failed logout call is not evidence the session
 * is still good; the safe assumption is that it is gone either way.
 */
export async function signOut(): Promise<boolean> {
  let ok: boolean;
  try {
    const response = await apiFetch("/api/auth/logout", {
      method: "POST",
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    ok = response.ok;
  } catch {
    ok = false;
  }
  clearPageCache();
  clearAllDrafts();
  return ok;
}

/**
 * Ends the session server-side, fades the whole app out and lands on the
 * login screen. The fade lives on <body> (opacity only — a transform here
 * would re-anchor position:fixed bars mid-fade) so it works from any page.
 *
 * Navigates exactly once, ever. `location.replace("/login")` is called
 * once and only once — nothing here starts a second, overlapping
 * navigation automatically.
 *
 * Why: a previous version fired an unconditional `location.assign("/login")`
 * 3 s later as a "fallback". A provisional navigation that is merely slow
 * (not dropped) is still pending at 3 s, so that second call cancelled the
 * first one. WebKit surfaces a cancelled navigation as `NSURLErrorCancelled`
 * (-999), which Capacitor 8 treats as a load failure and shows
 * `offline.html` for — recreating the exact lock-up this code exists to
 * prevent (final review I1, research H1).
 *
 * Fix: `pagehide` only fires once the browser actually commits to leaving
 * this document, so it is the one signal that distinguishes "the replace()
 * above is really taking the page away" from "nothing happened, or it was
 * cancelled". If it fires within 3 s, the navigation is real — resolve
 * `true` and stop watching. If it does not — stalled, cancelled, or just
 * unusually slow — stop waiting at 3 s, un-fade the body so the page is
 * tappable again, and resolve `false`. Callers already treat a `false`
 * result as "sign-out failed" and show an error with the sign-out button
 * still available, which is the retry: the user's own tap is the only
 * thing that starts a second navigation. If the original navigation was
 * only slow and completes on its own after the 3 s mark, the browser still
 * takes the page to /login by itself — this just stops the app waiting on
 * it.
 *
 * Mobile: none of the above applies -- there is no document to fade or
 * reload. signOutThisDevice() (auth-client.ts) already clears every
 * client-visible trace of the session regardless of whether the server
 * call itself succeeded, so this always resolves true once it returns.
 */
export async function leaveAfterSignOut(): Promise<boolean> {
  if (IS_MOBILE_BUILD) {
    await signOutThisDevice();
    appNavigate("/login", { replace: true });
    return true;
  }

  const ok = await signOut();
  if (logoutOutcome(ok) !== "login") return false;
  document.body.classList.add("signing-out");
  await new Promise((resolve) => setTimeout(resolve, 240));
  window.location.replace("/login");

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const onPageHide = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      window.removeEventListener("pagehide", onPageHide);
      document.body.classList.remove("signing-out");
      resolve(false);
    }, 3000);
    window.addEventListener("pagehide", onPageHide, { once: true });
  });
}

/**
 * The per-field messages of a refused request (`details: [{ field, message }]`
 * from the shared validation answer), keyed by the server's field name, so a
 * form can put each message at its field. Empty when the error carries none.
 */
export function fieldErrorsFromApi(error: unknown): Record<string, string> {
  if (!(error instanceof ApiError)) return {};
  // The envelope carries the list as `details`; a route that answers with a plain
  // `error` string carries it as `{ details: [...] }` beside it.
  const list = Array.isArray(error.details)
    ? error.details
    : error.details && typeof error.details === "object" && Array.isArray((error.details as { details?: unknown }).details)
      ? ((error.details as { details: unknown[] }).details)
      : null;
  if (!list) return {};
  const result: Record<string, string> = {};
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const { field, message } = item as { field?: unknown; message?: unknown };
    if (typeof field !== "string" || !field || typeof message !== "string") continue;
    if (!isUserFacingMessage(message)) continue;
    if (!(field in result)) result[field] = message;
  }
  return result;
}
