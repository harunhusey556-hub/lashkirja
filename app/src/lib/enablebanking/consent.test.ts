import { createHash } from "crypto";
import { describe, expect, it } from "vitest";
import {
  AUTH_STATE_TTL_MS,
  BANK_SYNC_INTERVAL_MS,
  authStateMatches,
  consentValidUntil,
  createAuthState,
  hashAuthState,
  isBankSyncDue,
  isPendingStateFresh,
  overlapDateFrom,
} from "./consent";

describe("auth state", () => {
  it("stores only a sha256 hash and rejects a different state", () => {
    const state = createAuthState();
    const hash = hashAuthState(state);
    expect(hash).toBe(createHash("sha256").update(state, "utf8").digest("hex"));
    expect(hash).not.toBe(state);
    expect(authStateMatches(hash, state)).toBe(true);
    expect(authStateMatches(hash, `${state}x`)).toBe(false);
    expect(authStateMatches(null, state)).toBe(false);
  });

  it("defaults to a bare 64-hex-char state with no prefix", () => {
    const state = createAuthState();
    expect(state).toMatch(/^[0-9a-f]{64}$/);
    expect(createAuthState("web")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("tags an app-started state with app1. plus 64 hex chars, still hashable", () => {
    const state = createAuthState("app");
    expect(state).toMatch(/^app1\.[0-9a-f]{64}$/);
    expect(state.length).toBe("app1.".length + 64);
    const hash = hashAuthState(state);
    expect(authStateMatches(hash, state)).toBe(true);
  });

  it("expires a pending consent after one hour", () => {
    const created = new Date("2026-09-26T08:00:00.000Z");
    expect(isPendingStateFresh(created, new Date(created.getTime() + AUTH_STATE_TTL_MS))).toBe(
      true
    );
    expect(
      isPendingStateFresh(created, new Date(created.getTime() + AUTH_STATE_TTL_MS + 1))
    ).toBe(false);
  });
});

describe("consent and sync windows", () => {
  it("keeps valid_until inside the ASPSP maximum", () => {
    const now = new Date("2026-09-26T12:00:00.000Z");
    const until = new Date(consentValidUntil(15552000, now));
    expect(until.getTime() - now.getTime()).toBe((15552000 - 60) * 1000);
  });

  it("uses a 90 day consent when the bank maximum is missing", () => {
    const now = new Date("2026-09-26T12:00:00.000Z");
    const until = new Date(consentValidUntil(0, now));
    expect(until.getTime() - now.getTime()).toBe(90 * 24 * 60 * 60 * 1000);
  });

  it("treats a sync as due after six hours and overlaps five days", () => {
    const now = new Date("2026-09-26T18:00:00.000Z");
    expect(isBankSyncDue(null, now)).toBe(true);
    expect(isBankSyncDue(new Date(now.getTime() - BANK_SYNC_INTERVAL_MS + 1000), now)).toBe(
      false
    );
    expect(isBankSyncDue(new Date(now.getTime() - BANK_SYNC_INTERVAL_MS), now)).toBe(true);
    expect(overlapDateFrom(new Date("2026-09-26T18:30:00.000Z"))).toBe("2026-09-21");
  });
});
