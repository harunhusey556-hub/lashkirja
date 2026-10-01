import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch, ApiGatewayError, readJson } from "./clientFetch";
import { connectivitySnapshotForTests, resetConnectivityForTests } from "@/lib/connectivity";
import { clearPageCache } from "@/lib/page-cache";

const MESSAGE = "Vahvistusviestiä ei voitu lähettää, joten sähköpostia ei vaihdettu.";

function appResponse(status: number, withVersion: boolean) {
  return new Response(JSON.stringify({ error: MESSAGE }), {
    status,
    headers: withVersion ? { "X-LashKirja-Api-Version": "2" } : {},
  });
}

describe("a 502/503/504 that the app itself sent (M2-6)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetConnectivityForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    clearPageCache();
    resetConnectivityForTests();
  });

  it("reaches the caller with its own message, and is not a network error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(appResponse(503, true));
    vi.stubGlobal("fetch", fetchMock);

    const response = await apiFetch("/api/auth/email", { method: "POST" });
    expect(response.status).toBe(503);
    await expect(readJson(response, "x")).rejects.toMatchObject({ message: MESSAGE, status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The server answered, so the offline banner must not come up.
    expect(connectivitySnapshotForTests().server).toBe("ok");
  });

  it("is not retried as if it were a gateway page", async () => {
    const fetchMock = vi.fn().mockResolvedValue(appResponse(502, true));
    vi.stubGlobal("fetch", fetchMock);
    const response = await apiFetch("/api/bank/aspsps");
    expect(response.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a gateway answer without the app's version header is still a gateway error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(appResponse(503, false));
    vi.stubGlobal("fetch", fetchMock);
    await expect(apiFetch("/api/auth/email", { method: "POST" })).rejects.toBeInstanceOf(ApiGatewayError);
  });
});
