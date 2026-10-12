import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/session", () => ({ requireSession: vi.fn() }));

import { requireSession } from "@/lib/session";
import { resetObserveForTests } from "@/lib/observe";
import { POST } from "./route";

function post(body: unknown) {
  return new NextRequest("http://localhost/api/observe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.mocked(requireSession).mockResolvedValue({ userId: "u1" } as never);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  resetObserveForTests();
  vi.restoreAllMocks();
});

describe("POST /api/observe", () => {
  it("accepts the web sources as before", async () => {
    expect((await POST(post({ message: "boom", source: "window" }))).status).toBe(200);
    expect((await POST(post({ message: "boom", source: "rejection" }))).status).toBe(200);
  });

  it("accepts a native report and logs it with route native", async () => {
    const res = await POST(post({ message: "api 503 GET /api/invoices/:id app=1.0.0(7) ios=18.2", source: "native" }));
    expect(res.status).toBe(200);
    const line = vi.mocked(console.error).mock.calls.map((c) => String(c[0])).find((l) => l.includes("client_error"));
    expect(line).toBeDefined();
    const event = JSON.parse(line as string);
    expect(event).toMatchObject({ observe: true, kind: "client_error", route: "native" });
    expect(event.message).toContain("/api/invoices/:id");
  });

  it("still rejects unknown sources and extra fields", async () => {
    expect((await POST(post({ message: "x", source: "ios" }))).status).toBe(400);
    expect((await POST(post({ message: "x", source: "native", extra: 1 }))).status).toBe(400);
  });

  it("requires a session", async () => {
    vi.mocked(requireSession).mockResolvedValue(null as never);
    expect((await POST(post({ message: "x", source: "native" }))).status).toBe(401);
  });
});
