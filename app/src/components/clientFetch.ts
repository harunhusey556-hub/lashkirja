import { clearAllDrafts } from "@/lib/draft-store";
import { clearPageCache, invalidateForMutation } from "@/lib/page-cache";
import { logoutOutcome } from "@/lib/session-policy";

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
      `Palvelin ei vastannut tilapäisesti (virhe ${status}). Tarkista onnistuiko toiminto ennen kuin yrität uudelleen.`
    );
    this.name = "ApiGatewayError";
    this.status = status;
  }
}

export type ApiFetchInit = RequestInit & { timeoutMs?: number };

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

async function apiFetchAttempt(input: RequestInfo | URL, init?: ApiFetchInit): Promise<Response> {
  const method = (init?.method || "GET").toUpperCase();
  const maxRetries = IDEMPOTENT_METHODS.has(method) ? 3 : 1;
  const timeoutMs = init?.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const rest: RequestInit = { ...(init ?? {}) };
  delete (rest as ApiFetchInit).timeoutMs;
  let attempt = 0;

  while (attempt < maxRetries) {
    const { signal, cleanup } = withTimeout(rest.signal, timeoutMs);
    try {
      const response = await fetch(input, { ...rest, signal });
      // If it's a 502/503/504 gateway/timeout error, we should retry!
      if (response.status === 502 || response.status === 503 || response.status === 504) {
        throw new ApiGatewayError(response.status);
      }
      if (response.ok && !IDEMPOTENT_METHODS.has(method)) {
        invalidateForMutation(requestUrl(input));
      }
      return response; // 2xx, 4xx, and 500 (logic errors) are returned normally
    } catch (error) {
      if (rest.signal?.aborted) throw error; // caller cancelled — not a timeout, not retryable
      if (
        error instanceof DOMException &&
        error.name === "AbortError"
      ) {
        throw new ApiTimeoutError();
      }
      attempt++;
      if (attempt >= maxRetries) {
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

export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

export function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.details) {
    // If we have detailed Zod/Validation issues, format them cleanly
    if (Array.isArray(error.details)) {
      return `${error.message}: ${error.details
        .map((issue) =>
          issue && typeof issue === "object" && "message" in issue
            ? String((issue as { message?: unknown }).message ?? issue)
            : String(issue)
        )
        .join(", ")}`;
    }
  }
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * Used whenever an API call comes back 401 mid-session (cookie expired or was
 * cleared server-side). Carries a reason so the login screen can explain why
 * the user landed there instead of silently dropping them on a blank form.
 */
export function redirectToLogin(): void {
  window.location.replace("/login?error=expired");
}

/**
 * Ends the session server-side, fades the whole app out and lands on the
 * login screen. The fade lives on <body> (opacity only — a transform here
 * would re-anchor position:fixed bars mid-fade) so it works from any page.
 */
/**
 * Ends the server session. Returns false when the call fails, without
 * navigating: the cookie may still be valid.
 */
export async function signOut(): Promise<boolean> {
  try {
    const response = await apiFetch("/api/auth/logout", {
      method: "POST",
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return false;
  } catch {
    return false;
  }
  clearPageCache();
  clearAllDrafts();
  return true;
}

/** Navigates to login only after the server accepted the logout. */
export async function leaveAfterSignOut(): Promise<boolean> {
  const ok = await signOut();
  if (logoutOutcome(ok) !== "login") return false;
  document.body.classList.add("signing-out");
  await new Promise((resolve) => setTimeout(resolve, 240));
  window.location.replace("/login");
  return true;
}
