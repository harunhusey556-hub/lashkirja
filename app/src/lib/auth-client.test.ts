import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * IS_MOBILE_BUILD is a build-time constant baked in at module load, so it
 * cannot be flipped per test the way a function could be -- this whole file
 * mocks build-target.ts to the mobile value, since every function under
 * test here (signOutThisDevice, expireSession, refreshTokenIfDue,
 * retryPendingRevoke, and signIn's mobile branch) exists only for the
 * mobile build. Web's signIn() branch (the JSON cookie login phase 1 left
 * in place) is unchanged code with no new behaviour to test here.
 */
vi.mock("@/lib/build-target", () => ({
  IS_MOBILE_BUILD: true,
  apiUrl: (path: string) => `http://127.0.0.1:3200${path}`,
}));

const navigated: Array<{ path: string; replace?: boolean }> = [];
vi.mock("@/lib/app-nav", () => ({
  appNavigate: (path: string, options?: { replace?: boolean }) => {
    navigated.push({ path, replace: options?.replace });
  },
  setAppRouter: () => {},
}));

const store = new Map<string, string>();
vi.mock("@/lib/mobile/secure-store", () => ({
  SECURE_KEYS: {
    auth: "lashkirja.auth.v1",
    cacheKey: "lashkirja.cachekey.v1",
    pendingRevoke: "lashkirja.pending-revoke.v1",
  },
  secureStore: () => ({
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string) => {
      store.set(key, value);
    },
    remove: async (key: string) => {
      store.delete(key);
    },
  }),
}));

import {
  expireSession,
  getAccessToken,
  loadStoredAuth,
  refreshTokenIfDue,
  resetTokenRefreshTriggersForTests,
  retryPendingRevoke,
  signIn,
  signOutThisDevice,
  startPeriodicRefreshCheck,
} from "./auth-client";
import { ensureCacheKey, resetCacheKeyProvisioning } from "@/lib/offline/persistent-cache";

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>) {
  return new Response(JSON.stringify(body), { status, headers });
}

async function signInAsDemo() {
  const fetchMock = vi.fn(async () =>
    jsonResponse(200, {
      token: "tok-1",
      tokenType: "Bearer",
      expiresAt: "2099-01-01T00:00:00.000Z",
      user: { userId: "user-1", email: "demo@lashkirja.fi", firstName: "Demo" },
    })
  );
  vi.stubGlobal("fetch", fetchMock);
  const result = await signIn({ email: "demo@lashkirja.fi", password: "demo123" });
  return { result, fetchMock };
}

beforeEach(() => {
  store.clear();
  navigated.length = 0;
});

afterEach(async () => {
  // Reset auth-client's module-level memory state so tests do not leak into
  // each other: clear the backing store FIRST, then loadStoredAuth() reads
  // that empty store and clears the in-memory copy too.
  store.clear();
  await loadStoredAuth();
  vi.unstubAllGlobals();
  // I4's periodic timer and "wired once" flag, and I1/I3's cache-key
  // provisioning lock, are module-level state too -- reset them so one
  // test's wiring/timer never leaks into the next.
  resetTokenRefreshTriggersForTests();
  resetCacheKeyProvisioning();
  vi.useRealTimers();
});

describe("signIn (mobile)", () => {
  it("stores the token and returns the user on success", async () => {
    const { result, fetchMock } = await signInAsDemo();

    expect(result).toEqual({
      ok: true,
      user: { userId: "user-1", email: "demo@lashkirja.fi", firstName: "Demo" },
    });
    expect(getAccessToken()).toBe("tok-1");
    expect(store.get("lashkirja.auth.v1")).toContain("tok-1");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3200/api/auth/token",
      expect.objectContaining({ credentials: "omit" })
    );
  });

  it("surfaces a 401 as ok:false without storing anything", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(401, { error: "Sähköposti tai salasana on väärin" }))
    );
    const result = await signIn({ email: "demo@lashkirja.fi", password: "wrong" });

    expect(result).toEqual({ ok: false, status: 401, error: "Sähköposti tai salasana on väärin" });
    expect(getAccessToken()).toBeNull();
  });

  it("surfaces a 429's Retry-After as retryAfter", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(429, { error: "Liian monta yritystä" }, { "Retry-After": "30" }))
    );
    const result = await signIn({ email: "demo@lashkirja.fi", password: "x" });

    expect(result).toEqual({ ok: false, status: 429, error: "Liian monta yritystä", retryAfter: 30 });
  });
});

describe("getAccessToken / loadStoredAuth", () => {
  it("returns null with nothing stored", async () => {
    expect(await loadStoredAuth()).toBeNull();
    expect(getAccessToken()).toBeNull();
  });

  it("reads back what signIn stored, from a fresh load", async () => {
    await signInAsDemo();
    // Simulate a relaunch: nothing forgets the in-memory copy except a
    // fresh loadStoredAuth() reading the same underlying store.
    const reloaded = await loadStoredAuth();
    expect(reloaded?.userId).toBe("user-1");
    expect(getAccessToken()).toBe("tok-1");
  });
});

describe("expireSession", () => {
  it("clears the stored auth and navigates once, then again after a new signIn", async () => {
    await signInAsDemo();

    await Promise.all([expireSession(), expireSession(), expireSession()]);

    expect(navigated).toEqual([{ path: "/login?error=expired", replace: true }]);
    expect(getAccessToken()).toBeNull();
    expect(store.has("lashkirja.auth.v1")).toBe(false);

    // A fresh sign-in starts a new signed-in period: the guard resets.
    await signInAsDemo();
    await expireSession();
    expect(navigated).toEqual([
      { path: "/login?error=expired", replace: true },
      { path: "/login?error=expired", replace: true },
    ]);
  });

  it("final review I3: awaits the wipe before navigating, so a fast re-login never inherits a stale cache key", async () => {
    await signInAsDemo();
    // Arms the persistent-cache key-provisioning lock, exactly like a
    // receipt capture or a page-cache write would during this session.
    const firstKey = await ensureCacheKey();

    // Before the fix, expireSession() fired the wipe fire-and-forget and
    // returned/navigated immediately -- `await expireSession()` here would
    // resolve before wipePersistentCache's `secureStore().remove` and
    // `resetCacheKeyProvisioning()` had actually run, so the very next
    // `ensureCacheKey()` call below would still see the stale, memoized
    // key instead of provisioning a fresh one.
    await expireSession();

    // Fast re-login: a new sign-in re-arms the cache for a new signed-in
    // period. The next key must be freshly provisioned, never the one the
    // wipe was supposed to have deleted.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, {
          token: "tok-2",
          expiresAt: "2099-01-01T00:00:00.000Z",
          user: { userId: "user-2", email: "demo@lashkirja.fi", firstName: "Demo" },
        })
      )
    );
    await signIn({ email: "demo@lashkirja.fi", password: "demo123" });

    const secondKey = await ensureCacheKey();
    expect(secondKey).not.toBe(firstKey);
  });
});

describe("startPeriodicRefreshCheck (I4's due logic)", () => {
  it("does not refresh before the 7-day threshold, even across many ticks", async () => {
    vi.useFakeTimers();
    await signInAsDemo();
    const fetchMock = vi.fn(async () => jsonResponse(200, {}));
    vi.stubGlobal("fetch", fetchMock);

    startPeriodicRefreshCheck(6 * 60 * 60 * 1000);
    await vi.advanceTimersByTimeAsync(6 * 24 * 60 * 60 * 1000); // 6 days of 6h ticks

    expect(fetchMock).not.toHaveBeenCalled();
    expect(getAccessToken()).toBe("tok-1");
  });

  it("refreshes once a periodic tick crosses the 7-day threshold, not only at boot", async () => {
    vi.useFakeTimers();
    await signInAsDemo();
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        token: "tok-2",
        expiresAt: "2099-02-01T00:00:00.000Z",
        user: { userId: "user-1" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    startPeriodicRefreshCheck(6 * 60 * 60 * 1000);
    await vi.advanceTimersByTimeAsync(8 * 24 * 60 * 60 * 1000); // past the threshold

    expect(fetchMock).toHaveBeenCalled();
    expect(getAccessToken()).toBe("tok-2");
  });

  it("a stop function returned by startPeriodicRefreshCheck cancels further ticks", async () => {
    vi.useFakeTimers();
    await signInAsDemo();
    const fetchMock = vi.fn(async () => jsonResponse(200, {}));
    vi.stubGlobal("fetch", fetchMock);

    const stop = startPeriodicRefreshCheck(6 * 60 * 60 * 1000);
    stop();
    await vi.advanceTimersByTimeAsync(30 * 24 * 60 * 60 * 1000); // a full month of ticks

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("refreshTokenIfDue", () => {
  it("does nothing before the refresh threshold", async () => {
    await signInAsDemo();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await refreshTokenIfDue(Date.now());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(getAccessToken()).toBe("tok-1");
  });

  it("refreshes and persists a new token once the threshold has passed", async () => {
    await signInAsDemo();
    const eightDaysLater = Date.now() + 8 * 24 * 60 * 60 * 1000;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, {
          token: "tok-2",
          expiresAt: "2099-02-01T00:00:00.000Z",
          user: { userId: "user-1" },
        })
      )
    );

    await refreshTokenIfDue(eightDaysLater);

    expect(getAccessToken()).toBe("tok-2");
    expect(store.get("lashkirja.auth.v1")).toContain("tok-2");
  });

  it("expires the session on a 401 refresh response", async () => {
    await signInAsDemo();
    const eightDaysLater = Date.now() + 8 * 24 * 60 * 60 * 1000;
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(401, {})));

    await refreshTokenIfDue(eightDaysLater);

    expect(getAccessToken()).toBeNull();
    expect(navigated).toEqual([{ path: "/login?error=expired", replace: true }]);
  });

  it("keeps the old token on a network error", async () => {
    await signInAsDemo();
    const eightDaysLater = Date.now() + 8 * 24 * 60 * 60 * 1000;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network error");
      })
    );

    await refreshTokenIfDue(eightDaysLater);

    expect(getAccessToken()).toBe("tok-1");
    expect(navigated).toEqual([]);
  });
});

describe("signOutThisDevice", () => {
  it("clears client state and returns true when the server call succeeds", async () => {
    await signInAsDemo();
    const fetchMock = vi.fn(async () => jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const ok = await signOutThisDevice();

    expect(ok).toBe(true);
    expect(getAccessToken()).toBeNull();
    expect(store.has("lashkirja.auth.v1")).toBe(false);
    expect(store.has("lashkirja.pending-revoke.v1")).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3200/api/auth/logout",
      expect.objectContaining({ credentials: "omit" })
    );
  });

  it("still clears client state, but keeps the token as pendingRevoke, when the server call fails", async () => {
    await signInAsDemo();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(500, {})));

    const ok = await signOutThisDevice();

    expect(ok).toBe(false);
    expect(getAccessToken()).toBeNull();
    expect(store.get("lashkirja.pending-revoke.v1")).toBe("tok-1");
  });
});

describe("retryPendingRevoke", () => {
  it("does nothing when nothing is pending", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await retryPendingRevoke();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retries the pending logout and clears it once it succeeds", async () => {
    store.set("lashkirja.pending-revoke.v1", "stale-tok");
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { ok: true })));

    await retryPendingRevoke();

    expect(store.has("lashkirja.pending-revoke.v1")).toBe(false);
  });

  it("keeps the pending entry when the retry itself fails", async () => {
    store.set("lashkirja.pending-revoke.v1", "stale-tok");
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(500, {})));

    await retryPendingRevoke();

    expect(store.get("lashkirja.pending-revoke.v1")).toBe("stale-tok");
  });
});

describe("sign-in flag and first-launch expiry", () => {
  function stubLocalStorage() {
    const data = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
    });
    return data;
  }

  it("writes the flag on sign-in and boot read, and clears it on sign-out", async () => {
    const flags = stubLocalStorage();
    await signInAsDemo();
    expect(flags.get("lashkirja.signedin.v1")).toBe("1");

    await signOutThisDevice();
    expect(flags.has("lashkirja.signedin.v1")).toBe(false);

    store.set("lashkirja.auth.v1", JSON.stringify({ token: "t", userId: "u", expiresAt: "", issuedAt: "" }));
    await loadStoredAuth();
    expect(flags.get("lashkirja.signedin.v1")).toBe("1");

    store.clear();
    await loadStoredAuth();
    expect(flags.has("lashkirja.signedin.v1")).toBe(false);
  });

  it("AUTH-06: a launch with no stored session lands on a plain /login, not the expired notice", async () => {
    stubLocalStorage();
    store.clear();
    await loadStoredAuth();
    await expireSession();
    expect(navigated).toEqual([{ path: "/login", replace: true }]);
  });

  it("AUTH-06: a rejected stored session still says it expired", async () => {
    stubLocalStorage();
    await signInAsDemo();
    await expireSession();
    expect(navigated).toEqual([{ path: "/login?error=expired", replace: true }]);
  });
});
