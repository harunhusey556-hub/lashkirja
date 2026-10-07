import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { errorFields, eventLogFile, scrubEvent, writeEvents } from "./event-log";

describe("scrubEvent", () => {
  it("drops secret-looking keys at any depth and keeps ids and actions", () => {
    const scrubbed = scrubEvent({
      kind: "request",
      requestId: "r1",
      password: "x",
      nested: { accessToken: "t", code: "123456", errorCode: "DECODE", iban: "FI00" },
    });
    expect(scrubbed).toEqual({ kind: "request", requestId: "r1", nested: { errorCode: "DECODE" } });
  });

  it("cuts long strings", () => {
    const scrubbed = scrubEvent({ message: "a".repeat(5000) }) as { message: string };
    expect(scrubbed.message.length).toBeLessThan(2100);
  });
});

describe("writeEvents", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "event-log-"));
    process.env.EVENT_LOG_DIR = dir;
  });
  afterEach(async () => {
    delete process.env.EVENT_LOG_DIR;
    await rm(dir, { recursive: true, force: true });
  });

  it("appends one JSON line per event to the day's file, in order", async () => {
    const now = new Date("2026-10-08T10:00:00Z");
    await writeEvents([{ source: "server", kind: "error", message: "boom" }], now);
    await writeEvents([{ source: "ios", kind: "screen", screen: "receipts", token: "secret" }], now);
    const lines = (await readFile(eventLogFile(now, dir), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.map((line) => line.kind)).toEqual(["error", "screen"]);
    expect(lines[0].ts).toBe("2026-10-08T10:00:00.000Z");
    expect(lines[1].token).toBeUndefined();
    expect(eventLogFile(now, dir)).toMatch(/events-2026-10-08\.log$/);
  });
});

describe("errorFields", () => {
  it("keeps name, message and the top of the stack", () => {
    const fields = errorFields(new TypeError("bad"));
    expect(fields.errorName).toBe("TypeError");
    expect(fields.message).toBe("bad");
    expect(fields.stack?.split("\n").length).toBeLessThanOrEqual(12);
    expect(errorFields("plain")).toEqual({ message: "plain" });
  });
});
