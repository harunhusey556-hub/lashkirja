import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/session", () => ({ requireSession: vi.fn() }));

import { requireSession } from "@/lib/session";
import { eventLogFile } from "@/lib/event-log";
import { clearRateLimit } from "@/lib/rate-limit";
import { POST } from "./route";

function post(body: unknown) {
  return new NextRequest("http://localhost/api/observe/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const batch = {
  sessionId: "s1",
  app: { version: "1.0", build: "42", os: "26.0" },
  events: [
    { ts: "2026-10-08T10:00:00Z", kind: "screen", screen: "receipts" },
    { ts: "2026-10-08T10:00:01Z", kind: "request", method: "POST", path: "/api/receipts", status: 500, durationMs: 120, requestId: "abc" },
    { ts: "2026-10-08T10:00:02Z", kind: "report", name: "K7Q2XM", message: "kuva ei latautunut" },
  ],
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "events-route-"));
  process.env.EVENT_LOG_DIR = dir;
  vi.mocked(requireSession).mockResolvedValue({ userId: "u1" } as never);
  vi.spyOn(console, "error").mockImplementation(() => {});
  clearRateLimit("event-log:u1");
});
afterEach(async () => {
  delete process.env.EVENT_LOG_DIR;
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe("POST /api/observe/events", () => {
  it("writes the app's batch with the user and session", async () => {
    const response = await POST(post(batch));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, received: 3 });
    const lines = (await readFile(eventLogFile(new Date(), dir), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatchObject({ source: "ios", userId: "u1", sessionId: "s1", requestId: "abc", status: 500, app: "1.0(42) ios=26.0" });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("[problem-report] K7Q2XM"));
  });

  it("refuses a signed-out caller and a malformed batch", async () => {
    vi.mocked(requireSession).mockResolvedValueOnce(null as never);
    expect((await POST(post(batch))).status).toBe(401);
    expect((await POST(post({ sessionId: "s1", events: [] }))).status).toBe(400);
  });
});
