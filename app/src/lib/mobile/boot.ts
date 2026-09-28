/**
 * The mobile boot sequence: is there a stored session, and whose is it.
 * Replaces BootRedirect's placeholder uncredentialed fetch (Task 4) with a
 * real Keychain read. Task 7 adds the persistent cache: opened for the
 * signed-in user, hydrated into page-cache.ts within a fixed budget so a
 * slow or unavailable IndexedDB never delays the boot decision itself.
 */
import { loadStoredAuth, refreshTokenIfDue, retryPendingRevoke } from "@/lib/auth-client";
import { apiUrl } from "@/lib/build-target";
import { configureHttpCachePersistence } from "@/lib/offline/http-cache";
import { configurePageCachePersistence, hydratePageCache } from "@/lib/page-cache";
import { openPersistentCache, peekCacheOwner, PERSISTENT_LIMITS } from "@/lib/offline/persistent-cache";

export interface BootResult {
  signedIn: boolean;
  userId: string | null;
}

/** Boot must never wait long on IndexedDB: a value on time is used, a slow
 * or hung open/read is abandoned and the app continues memory-only. */
const HYDRATE_BUDGET_MS = 250;

let bootPromise: Promise<BootResult> | null = null;
let reportedCacheUnavailable = false;

function withBudget<T>(promise: Promise<T>, budgetMs: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: T | undefined) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(() => finish(undefined), budgetMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        finish(value);
      },
      () => {
        clearTimeout(timer);
        finish(undefined);
      }
    );
  });
}

/**
 * Once per app launch, best-effort, never blocks anything on its result.
 * A raw `fetch` (not `apiFetch`) on purpose: `apiFetch` awaits
 * `bootMobile()` itself, and this call happens from inside `runBoot()` --
 * awaiting the very promise this function is part of would deadlock.
 */
function reportCacheUnavailable(token: string | null): void {
  if (reportedCacheUnavailable) return;
  reportedCacheUnavailable = true;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  void fetch(apiUrl("/api/observe"), {
    method: "POST",
    credentials: "omit",
    headers,
    body: JSON.stringify({ message: "offline_cache_unavailable", source: "window" }),
  }).catch(() => {});
}

/**
 * Opens the persistent cache for `userId`, wires it into page-cache.ts and
 * http-cache.ts, and hydrates the in-memory page cache from it. Exported
 * (not just called from boot) because a sign-in can also happen without a
 * fresh app launch -- an explicit sign-out already wipes and un-configures
 * everything (auth-client.ts's `clearClientAuthState`), but `bootMobile()`
 * itself only ever runs once per launch, so the *next* sign-in in that same
 * running session needs this re-armed directly rather than through a boot
 * that will not run again.
 */
export async function activatePersistentCache(userId: string, token: string | null): Promise<void> {
  const cache = await openPersistentCache(userId);
  if (!cache) {
    configurePageCachePersistence(null);
    configureHttpCachePersistence(null);
    reportCacheUnavailable(token);
    return;
  }

  const previousOwner = await peekCacheOwner();
  if (previousOwner && previousOwner !== userId) {
    await cache.clear();
  }

  configurePageCachePersistence(cache, PERSISTENT_LIMITS.maxAgeMs, PERSISTENT_LIMITS.pageEntries);
  configureHttpCachePersistence(cache);

  const hydrated = await cache.entries("page:");
  hydratePageCache(hydrated);
}

async function runBoot(): Promise<BootResult> {
  const stored = await loadStoredAuth();
  // "app launch" retry point for a logout whose server call failed earlier.
  void retryPendingRevoke();
  if (!stored) return { signedIn: false, userId: null };
  // Fire-and-forget: a slow or failed refresh must not block the boot
  // decision -- the stored token is still valid right up to its own expiry.
  void refreshTokenIfDue();
  // Opening IndexedDB, checking the previous owner and decrypting every
  // cached page all happen on the same promise chain. `withBudget` only
  // stops *this* boot decision from waiting past 250 ms for it -- the
  // chain itself keeps running in the background and still wires up
  // page-cache.ts/http-cache.ts and hydrates once it finishes, just later
  // than this function's own return.
  await withBudget(activatePersistentCache(stored.userId, stored.token), HYDRATE_BUDGET_MS);
  return { signedIn: true, userId: stored.userId };
}

/** Memoized: resolves in one pass per app launch. */
export function bootMobile(): Promise<BootResult> {
  if (!bootPromise) bootPromise = runBoot();
  return bootPromise;
}
