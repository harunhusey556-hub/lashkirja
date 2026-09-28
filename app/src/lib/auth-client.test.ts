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
  retryPendingRevoke,
  signIn,
  signOutThisDevice,
} from "./auth-client";

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

    expireSession();
    expireSession();
    expireSession();

    expect(navigated).toEqual([{ path: "/login?error=expired", replace: true }]);
    expect(getAccessToken()).toBeNull();
    expect(store.has("lashkirja.auth.v1")).toBe(false);

    // A fresh sign-in starts a new signed-in period: the guard resets.
    await signInAsDemo();
    expireSession();
    expect(navigated).toEqual([
      { path: "/login?error=expired", replace: true },
      { path: "/login?error=expired", replace: true },
    ]);
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
