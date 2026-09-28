import { describe, expect, it } from "vitest";
import {
  applyBootOutcome,
  applyMeOutcome,
  initialSessionState,
  resetSessionStateForTests,
  sharedMeFetch,
  type MeOutcome,
  type SessionState,
} from "./session-state";

describe("initialSessionState", () => {
  it("starts signed-in on the web target (the proxy already gated the page)", () => {
    expect(initialSessionState(null, false)).toEqual({ status: "signed-in", user: null });
  });

  it("starts unknown on the mobile target (no server gate to trust yet)", () => {
    expect(initialSessionState(null, true)).toEqual({ status: "unknown", user: null });
  });

  it("carries the cached user through on both targets", () => {
    const cached = { userId: "u1", firstName: "Aino" };
    expect(initialSessionState(cached, false).user).toEqual(cached);
    expect(initialSessionState(cached, true).user).toEqual(cached);
  });
});

describe("applyBootOutcome", () => {
  it("a stored token means an optimistic signed-in, keeping any cached user", () => {
    const state: SessionState = { status: "unknown", user: { userId: "u1" } };
    expect(applyBootOutcome(state, true)).toEqual({ status: "signed-in", user: { userId: "u1" } });
  });

  it("no stored token means signed-out with no user, regardless of what was cached", () => {
    const state: SessionState = { status: "unknown", user: { userId: "stale" } };
    expect(applyBootOutcome(state, false)).toEqual({ status: "signed-out", user: null });
  });
});

describe("applyMeOutcome", () => {
  const base: SessionState = { status: "unknown", user: null };

  it("ok replaces the user and marks signed-in", () => {
    const outcome: MeOutcome = { kind: "ok", user: { userId: "u1", firstName: "Aino" } };
    expect(applyMeOutcome(base, outcome)).toEqual({
      status: "signed-in",
      user: { userId: "u1", firstName: "Aino" },
    });
  });

  it("unauthorized signs out and clears the user", () => {
    const signedIn: SessionState = { status: "signed-in", user: { userId: "u1" } };
    expect(applyMeOutcome(signedIn, { kind: "unauthorized" })).toEqual({
      status: "signed-out",
      user: null,
    });
  });

  it("a network error keeps the exact previous state, cached user included", () => {
    const signedIn: SessionState = { status: "signed-in", user: { userId: "u1" } };
    expect(applyMeOutcome(signedIn, { kind: "network-error" })).toBe(signedIn);
  });
});

describe("sharedMeFetch", () => {
  it("collapses two concurrent callers into one fetcher invocation", async () => {
    resetSessionStateForTests();
    let calls = 0;
    let resolve: ((outcome: MeOutcome) => void) | null = null;
    const fetcher = () =>
      new Promise<MeOutcome>((res) => {
        calls++;
        resolve = res;
      });

    const first = sharedMeFetch(fetcher);
    const second = sharedMeFetch(fetcher);
    expect(calls).toBe(1);
    expect(first).toBe(second);

    resolve!({ kind: "ok", user: { userId: "u1" } });
    await expect(first).resolves.toEqual({ kind: "ok", user: { userId: "u1" } });
  });

  it("starts a fresh fetch once the previous one has settled", async () => {
    resetSessionStateForTests();
    let calls = 0;
    const fetcher = async (): Promise<MeOutcome> => {
      calls++;
      return { kind: "ok", user: {} };
    };

    await sharedMeFetch(fetcher);
    await sharedMeFetch(fetcher);
    expect(calls).toBe(2);
  });
});
