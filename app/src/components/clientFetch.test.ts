import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch, ApiGatewayError, ApiTimeoutError } from "./clientFetch";
import { clearPageCache, readPageCache, writePageCache } from "@/lib/page-cache";

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
