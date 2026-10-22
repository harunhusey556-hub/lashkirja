import fs, { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LOW_SPACE_BYTES, diskHealth, healthAuthOk } from "@/lib/health";
import { pollDelay } from "@/lib/page-activity";
import {
  allowClientReport,
  publicErrorMessage,
  redactValue,
  resetObserveForTests,
  sentryEnvelopeUrl,
  slowQueryMs,
} from "@/lib/observe";

afterEach(() => {
  resetObserveForTests();
  delete process.env.SLOW_QUERY_MS;
});

describe("redaction", () => {
  it("drops secrets and query strings", () => {
    expect(
      redactValue({
        password: "hunter2",
        token: "abc",
        invoiceIban: "FI00",
        note: "Bearer raw-token",
      })
    ).toEqual({
      password: "[redacted]",
      token: "[redacted]",
      invoiceIban: "[redacted]",
      note: "Bearer [redacted]",
    });
    expect(publicErrorMessage("fail https://app.example/api/x?token=secret")).toBe(
      "fail https://app.example/api/x"
    );
  });

  it("builds a Sentry envelope URL without logging the DSN userinfo twice", () => {
    expect(sentryEnvelopeUrl("https://publickey@o1.ingest.sentry.io/42")).toBe(
      "https://o1.ingest.sentry.io/api/42/envelope/?sentry_key=publickey"
    );
    expect(sentryEnvelopeUrl("not a dsn")).toBeNull();
  });

  it("rate-limits client reports and reads the slow-query threshold", () => {
    for (let i = 0; i < 10; i += 1) expect(allowClientReport(1_000)).toBe(true);
    expect(allowClientReport(1_000)).toBe(false);
    expect(allowClientReport(61_001)).toBe(true);
    process.env.SLOW_QUERY_MS = "50";
    expect(slowQueryMs()).toBe(50);
  });
});

describe("health gate", () => {
  it("requires a token in production and checks the uploads directory", () => {
    const previous = process.env.HEALTH_TOKEN;
    delete process.env.HEALTH_TOKEN;
    expect(healthAuthOk(null, "production")).toBe(false);
    expect(healthAuthOk(null, "test")).toBe(true);
    process.env.HEALTH_TOKEN = "ops-token";
    expect(healthAuthOk("Bearer ops-token", "production")).toBe(true);
    expect(healthAuthOk("Bearer other", "production")).toBe(false);
    if (previous == null) delete process.env.HEALTH_TOKEN;
    else process.env.HEALTH_TOKEN = previous;

    const root = mkdtempSync(path.join(tmpdir(), "lashkirja-disk-"));
    expect(diskHealth(path.join(root, "missing")).ok).toBe(false);
    const uploads = path.join(root, "uploads");
    mkdirSync(uploads);
    // Threshold 0: this asserts writability, not how much space the machine running the test has.
    expect(diskHealth(uploads, 0)).toEqual({ ok: true, detail: "writable" });
  });

  it("warns about low space from 5 GB down, not only when the disk is nearly full", () => {
    const root = mkdtempSync(path.join(tmpdir(), "lashkirja-disk-"));
    const uploads = path.join(root, "uploads");
    mkdirSync(uploads);
    const gib = 1024 * 1024 * 1024;
    const statfs = vi.spyOn(fs, "statfsSync");
    const withFree = (bytes: number) => statfs.mockImplementation(() => ({ bavail: bytes / 4096, bsize: 4096 }) as never);
    try {
      expect(LOW_SPACE_BYTES).toBe(5 * gib);
      // 2.7 GB free was the prod disk on 2026-10-21: the old 50 MB limit called that fine.
      withFree(2.7 * gib);
      expect(diskHealth(uploads)).toEqual({ ok: false, detail: "low-space" });
      withFree(5 * gib);
      expect(diskHealth(uploads)).toEqual({ ok: true, detail: "writable" });
      withFree(5 * gib - 4096);
      expect(diskHealth(uploads)).toEqual({ ok: false, detail: "low-space" });
    } finally {
      statfs.mockRestore();
    }
  });
});

describe("background polling", () => {
  it("pauses while the document is hidden and resumes when it is visible", () => {
    expect(pollDelay("hidden", 4000)).toBeNull();
    expect(pollDelay("visible", 4000)).toBe(4000);
  });
});
