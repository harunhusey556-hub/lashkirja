import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { diskHealth, healthAuthOk } from "@/lib/health";
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
    expect(diskHealth(uploads)).toEqual({ ok: true, detail: "writable" });
  });
});

describe("background polling", () => {
  it("pauses while the document is hidden and resumes when it is visible", () => {
    expect(pollDelay("hidden", 4000)).toBeNull();
    expect(pollDelay("visible", 4000)).toBe(4000);
  });
});
