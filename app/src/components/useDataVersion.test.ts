import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BUMP_COALESCE_MS, getDataVersion, resetDataVersion } from "@/lib/data-version";
import { useDataVersion } from "./useDataVersion";
import { apiFetch } from "./clientFetch";

function Probe() {
  return createElement("span", null, `v${useDataVersion()}`);
}

describe("useDataVersion", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetDataVersion();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetDataVersion();
    vi.unstubAllGlobals();
  });

  it("starts at 0 on the server render and in the first client render", () => {
    expect(renderToStaticMarkup(createElement(Probe))).toBe("<span>v0</span>");
  });

  it("moves when a successful write to a data route happens through apiFetch (the sync/import/save bump)", async () => {
    const calls: Array<{ url: string; cache?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), cache: init?.cache });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      })
    );
    expect(getDataVersion()).toBe(0);
    await apiFetch("/api/bank/connections/c1/sync", { method: "POST" });
    vi.advanceTimersByTime(BUMP_COALESCE_MS);
    expect(getDataVersion()).toBe(1);
    // A write that touches no screen data (login, chat) does not make every screen refetch.
    await apiFetch("/api/auth/login", { method: "POST" });
    vi.advanceTimersByTime(BUMP_COALESCE_MS);
    expect(getDataVersion()).toBe(1);
  });

  it("revalidates every GET with the browser cache instead of trusting a kept copy", async () => {
    const seen: Array<string | undefined> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(init?.cache);
        return new Response("{}", { status: 200 });
      })
    );
    await apiFetch("/api/statements?limit=50");
    await apiFetch("/api/dashboard?month=2026-10", { cache: "no-store" });
    expect(seen).toEqual(["no-cache", "no-store"]);
  });
});
