import { afterEach, describe, expect, it } from "vitest";
import {
  consumeRateLimit,
  RECEIPT_UPLOADS_PER_WINDOW,
  resetRateLimitsForTests,
} from "./rate-limit";

describe("receipt upload rate limit", () => {
  afterEach(() => resetRateLimitsForTests());

  it("admits a migration-size import in one 10-minute window", () => {
    // The ceiling exists to stop a runaway client, not to throttle a migration:
    // a company moving onto the app brings in hundreds of receipts at once.
    expect(RECEIPT_UPLOADS_PER_WINDOW).toBeGreaterThanOrEqual(200);
  });

  it("allows a window's worth and then refuses with Retry-After", () => {
    const limit = 3;
    const windowMs = 600_000;
    for (let index = 0; index < limit; index += 1) {
      expect(consumeRateLimit("k", limit, windowMs, 1000).allowed).toBe(true);
    }
    const exhausted = consumeRateLimit("k", limit, windowMs, 1000);
    expect(exhausted.allowed).toBe(false);
    expect(exhausted.remaining).toBe(0);
    expect(exhausted.retryAfterSeconds).toBeGreaterThan(0);
    // A fresh window starts over.
    expect(consumeRateLimit("k", limit, windowMs, 1000 + windowMs + 1).allowed).toBe(true);
  });
});
