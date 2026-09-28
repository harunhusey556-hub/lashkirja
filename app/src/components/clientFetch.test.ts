import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch, ApiGatewayError, ApiTimeoutError, leaveAfterSignOut, redirectToLogin } from "./clientFetch";
import { clearPageCache, readPageCache, writePageCache } from "@/lib/page-cache";

/** Minimal in-memory localStorage: enough for draft-store's clearAllDrafts()
 * (called inside signOut()) to run without throwing. The unit suite has no
 * DOM (no jsdom dependency is installed), so `window`/`document` are stubbed
 * by hand per test rather than provided by an environment. */
function fakeLocalStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    get length() {
      return store.size;
    },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
  };
}

function jsonResponse(status: number, body: unknown = {}) {
  return new Response(JSON.stringify(body), { status });
}

/** Mimics a real fetch: rejects with a DOMException AbortError once the
 * request's own signal aborts, otherwise resolves with `response`. */
function fetchThatRespectsAbort(response: Response) {
  return (_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(new DOMException("aborted", "AbortError"));
        return;
      }
      signal?.addEventListener("abort", () => {
        reject(new DOMException("aborted", "AbortError"));
      });
      resolve(response);
    });
}

describe("apiFetch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    clearPageCache();
  });

  it("clears related caches after a successful write and leaves them after a read", async () => {
    writePageCache("invoices", [{ id: "1" }]);
    writePageCache("profile", { email: "a@b.c" });
    vi.stubGlobal("fetch", vi.fn(fetchThatRespectsAbort(jsonResponse(200))));
    await apiFetch("/api/invoices", { method: "POST" });
    expect(readPageCache("invoices")).toBeNull();
    expect(readPageCache("profile")).toEqual({ email: "a@b.c" });

    writePageCache("invoices", [{ id: "1" }]);
    await apiFetch("/api/invoices");
    expect(readPageCache("invoices")).toEqual([{ id: "1" }]);
  });

  it("returns the response as-is on success", async () => {
    vi.stubGlobal("fetch", vi.fn(fetchThatRespectsAbort(jsonResponse(200))));
    const response = await apiFetch("/api/x", { credentials: "include" });
    expect(response.status).toBe(200);
  });

  it("retries a GET on a transient gateway error and succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(fetchThatRespectsAbort(jsonResponse(503)))
      .mockImplementationOnce(fetchThatRespectsAbort(jsonResponse(200)));
    vi.stubGlobal("fetch", fetchMock);

    const promise = apiFetch("/api/x");
    await vi.advanceTimersByTimeAsync(1000); // 500ms backoff after attempt 1
    const response = await promise;

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a non-idempotent POST on a gateway error, and surfaces a clean message", async () => {
    const fetchMock = vi.fn(fetchThatRespectsAbort(jsonResponse(502)));
    vi.stubGlobal("fetch", fetchMock);

    await expect(apiFetch("/api/x", { method: "POST" })).rejects.toBeInstanceOf(ApiGatewayError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("times out a hung request instead of spinning forever", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError"))
            );
          })
      )
    );

    const promise = apiFetch("/api/x");
    const assertion = expect(promise).rejects.toBeInstanceOf(ApiTimeoutError);
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
  });

  it("does not convert a caller-initiated cancellation into a timeout error", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError"))
            );
          })
      )
    );

    const promise = apiFetch("/api/x", { signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.not.toBeInstanceOf(ApiTimeoutError);
  });

  it("dedupes identical in-flight GETs and gives each caller its own body", async () => {
    const fetchMock = vi.fn(fetchThatRespectsAbort(jsonResponse(200, { ok: true })));
    vi.stubGlobal("fetch", fetchMock);

    const [first, second] = await Promise.all([apiFetch("/api/same"), apiFetch("/api/same")]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await first.json()).toEqual({ ok: true });
    expect(await second.json()).toEqual({ ok: true });
  });
});

describe("leaveAfterSignOut", () => {
  let replace: ReturnType<typeof vi.fn>;
  let assign: ReturnType<typeof vi.fn>;
  let classList: { add: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> };
  let listeners: Map<string, Set<(...args: unknown[]) => void>>;
  let addEventListener: ReturnType<typeof vi.fn>;
  let removeEventListener: ReturnType<typeof vi.fn>;

  function fireWindowEvent(name: string) {
    for (const handler of listeners.get(name) ?? []) handler();
  }

  beforeEach(() => {
    vi.useFakeTimers();
    replace = vi.fn();
    assign = vi.fn();
    classList = { add: vi.fn(), remove: vi.fn() };
    listeners = new Map();
    addEventListener = vi.fn((name: string, handler: (...args: unknown[]) => void) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(handler);
    });
    removeEventListener = vi.fn((name: string, handler: (...args: unknown[]) => void) => {
      listeners.get(name)?.delete(handler);
    });
    vi.stubGlobal("window", {
      location: { replace, assign },
      localStorage: fakeLocalStorage(),
      addEventListener,
      removeEventListener,
    });
    vi.stubGlobal("document", { body: { classList } });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    clearPageCache();
  });

  it("navigates to /login exactly once and resolves true as soon as the page actually unloads (pagehide)", async () => {
    vi.stubGlobal("fetch", vi.fn(fetchThatRespectsAbort(jsonResponse(200))));

    const promise = leaveAfterSignOut();
    await vi.advanceTimersByTimeAsync(240); // the fade delay before the first navigate

    expect(classList.add).toHaveBeenCalledWith("signing-out");
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith("/login");

    // Simulate the browser actually committing to leave this document.
    fireWindowEvent("pagehide");
    await expect(promise).resolves.toBe(true);

    // Never a second, overlapping navigation.
    expect(assign).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalledTimes(1);
    // pagehide firing means the document is genuinely gone; no need to un-fade it.
    expect(classList.remove).not.toHaveBeenCalled();
  });

  it("never starts a second navigation if /login has not taken the page away after 3s; it un-fades and resolves false instead", async () => {
    vi.stubGlobal("fetch", vi.fn(fetchThatRespectsAbort(jsonResponse(200))));

    const promise = leaveAfterSignOut();
    await vi.advanceTimersByTimeAsync(240);

    // No pagehide fires: the first navigation stalled, was cancelled, or is
    // merely slow. The old code called location.assign("/login") here,
    // which is exactly the overlapping-navigation bug (I1) — assert it is
    // gone.
    await vi.advanceTimersByTimeAsync(3000);
    await expect(promise).resolves.toBe(false);

    expect(replace).toHaveBeenCalledTimes(1); // still only ever called once
    expect(assign).not.toHaveBeenCalled(); // NEVER a second, automatic navigation
    expect(classList.remove).toHaveBeenCalledWith("signing-out");
  });

  it("resolving via pagehide cancels the 3s fallback so it never un-fades or fires late", async () => {
    vi.stubGlobal("fetch", vi.fn(fetchThatRespectsAbort(jsonResponse(200))));

    const promise = leaveAfterSignOut();
    await vi.advanceTimersByTimeAsync(240);
    fireWindowEvent("pagehide");
    await promise;

    await vi.advanceTimersByTimeAsync(3000);
    expect(classList.remove).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it("never fades the page when the server logout call fails, but still clears cached data", async () => {
    writePageCache("invoices", [{ id: "1" }]);
    vi.stubGlobal("fetch", vi.fn(fetchThatRespectsAbort(jsonResponse(500))));

    const left = await leaveAfterSignOut();

    expect(left).toBe(false);
    expect(classList.add).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(readPageCache("invoices")).toBeNull();
  });
});

describe("redirectToLogin", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("navigates at most once per page lifetime even when called repeatedly", () => {
    const replace = vi.fn();
    vi.stubGlobal("window", { location: { replace } });

    redirectToLogin();
    redirectToLogin();
    redirectToLogin();

    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith("/login?error=expired");
  });
});
