/**
 * The HTTP GET fallback cache: a stale, previously-successful JSON
 * response served back only when the live network attempt has already
 * failed (clientFetch.ts) or the device is already known offline (Task
 * 8). It never competes with, or short-circuits, a working network call.
 *
 * Stored under the persistent cache's "http:<path+query>" key space
 * (persistent-cache.ts), sharing its encryption and its own entry-count
 * limit (`PERSISTENT_LIMITS.httpEntries`).
 */
import { PERSISTENT_LIMITS, type PersistentCache } from "./persistent-cache";

interface StoredHttpResponse {
  status: number;
  contentType: string;
  body: string;
}

const EXCLUDED_EXACT = ["/api/health", "/api/observe"];
const EXCLUDED_PREFIXES = ["/api/auth/", "/api/jobs/"];

function pathname(url: string): string {
  try {
    return new URL(url, "http://cache.invalid").pathname;
  } catch {
    return url.split("?")[0] ?? url;
  }
}

function pathAndQuery(url: string): string {
  try {
    const parsed = new URL(url, "http://cache.invalid");
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

function httpCacheKey(url: string): string {
  return `http:${pathAndQuery(url)}`;
}

/**
 * The method itself is not checked here (a `Response` carries no record of
 * the request that produced it) -- every caller in this codebase only ever
 * calls this for a GET response, matching the function's name. Every other
 * criterion (status, content type, path, exclusions) is checked here.
 */
export function isCacheableGet(url: string, response: Response): boolean {
  if (response.status !== 200) return false;
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes("application/json")) return false;

  const path = pathname(url);
  if (!path.startsWith("/api/")) return false;
  if (EXCLUDED_EXACT.includes(path)) return false;
  if (EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix))) return false;
  return true;
}

let store: PersistentCache | null = null;

/**
 * Wired by `bootMobile()` once the persistent cache is open, mirroring
 * `page-cache.ts`'s `configurePageCachePersistence` -- this module holds
 * no `PersistentCache` of its own otherwise, so `rememberGet` and
 * `staleResponseFor` are no-ops (never throw) until this has run.
 */
export function configureHttpCachePersistence(next: PersistentCache | null): void {
  store = next;
}

export async function rememberGet(url: string, response: Response): Promise<void> {
  if (!store) return;
  if (!isCacheableGet(url, response)) return;
  try {
    const body = await response.clone().text();
    if (new TextEncoder().encode(body).length > PERSISTENT_LIMITS.httpBodyMaxBytes) return;
    const value: StoredHttpResponse = {
      status: response.status,
      contentType: response.headers.get("content-type") || "application/json",
      body,
    };
    await store.set(httpCacheKey(url), value);
  } catch {
    // Best-effort only -- a caching failure must never surface as a
    // request failure to the caller that just got a good response.
  }
}

/** A `Response` rebuilt from the cache, or null on a miss. Headers mark it
 * unambiguously as a stale replay, never mistaken for a live response. */
export async function staleResponseFor(url: string): Promise<Response | null> {
  if (!store) return null;
  const record = await store.get<StoredHttpResponse>(httpCacheKey(url));
  if (!record) return null;
  const headers = new Headers({
    "content-type": record.value.contentType,
    "X-LashKirja-Cache": "stale",
    "X-LashKirja-Fetched-At": new Date(record.fetchedAt).toISOString(),
  });
  return new Response(record.value.body, { status: record.value.status, headers });
}
