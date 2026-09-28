import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertCanWrite,
  connectivitySnapshotForTests,
  isServerNewer,
  nextDeviceState,
  nextServerState,
  reportRequestOutcome,
  resetConnectivityForTests,
  setDeviceStateForTests,
} from "./connectivity";

beforeEach(() => {
  resetConnectivityForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetConnectivityForTests();
});

describe("nextDeviceState", () => {
  it("connected -> online, not connected -> offline", () => {
    expect(nextDeviceState(true)).toBe("online");
    expect(nextDeviceState(false)).toBe("offline");
  });
});

describe("nextServerState (transition table)", () => {
  const table: Array<[string, "ok" | "network-error", number, { server: "ok" | "unreachable"; consecutiveErrors: number }]> = [
    ["ok from ok resets the counter", "ok", 0, { server: "ok", consecutiveErrors: 0 }],
    ["ok from unreachable recovers immediately", "ok", 5, { server: "ok", consecutiveErrors: 0 }],
    ["first error alone is not unreachable yet", "network-error", 0, { server: "ok", consecutiveErrors: 1 }],
    ["a second error in a row is unreachable", "network-error", 1, { server: "unreachable", consecutiveErrors: 2 }],
    ["further errors stay unreachable", "network-error", 4, { server: "unreachable", consecutiveErrors: 5 }],
  ];

  for (const [label, outcome, consecutiveErrors, expected] of table) {
    it(label, () => {
      // "ok" from "unreachable" and "ok" from "ok" both take `current`
      // "ok", since the function itself never reads `current` on that
      // branch -- the starting `server` argument is irrelevant to the
      // outcome, only to documenting intent per row.
      expect(nextServerState("ok", outcome, consecutiveErrors)).toEqual(expected);
    });
  }

  it("network-error never downgrades an already-unreachable state on its own count", () => {
    expect(nextServerState("unreachable", "network-error", 2)).toEqual({
      server: "unreachable",
      consecutiveErrors: 3,
    });
  });
});

describe("reportRequestOutcome", () => {
  it("two consecutive network errors flip the server to unreachable", () => {
    reportRequestOutcome("network-error");
    expect(connectivitySnapshotForTests().server).toBe("ok");
    reportRequestOutcome("network-error");
    expect(connectivitySnapshotForTests().server).toBe("unreachable");
  });

  it("one ok in between resets the count", () => {
    reportRequestOutcome("network-error");
    reportRequestOutcome("ok");
    reportRequestOutcome("network-error");
    expect(connectivitySnapshotForTests().server).toBe("ok");
  });

  it("records lastOkAt only on an ok outcome, and the server's API version when given", () => {
    const before = Date.now();
    reportRequestOutcome("ok", 3);
    const snapshot = connectivitySnapshotForTests();
    expect(snapshot.lastOkAt).not.toBeNull();
    expect(snapshot.lastOkAt!).toBeGreaterThanOrEqual(before);
    expect(snapshot.serverApiVersion).toBe(3);
  });

  it("a network-error does not touch lastOkAt or a previously-seen API version", () => {
    reportRequestOutcome("ok", 2);
    const lastOkAt = connectivitySnapshotForTests().lastOkAt;
    reportRequestOutcome("network-error");
    const snapshot = connectivitySnapshotForTests();
    expect(snapshot.lastOkAt).toBe(lastOkAt);
    expect(snapshot.serverApiVersion).toBe(2);
  });
});

describe("probe scheduling (fake timers)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("starts probing every 15s once unreachable, and stops once ok", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    reportRequestOutcome("network-error");
    reportRequestOutcome("network-error"); // now unreachable, probe armed
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(15_000);
    // Any HTTP status (even 401) counts as reachable -- the very first
    // probe's own fetch resolving is what reports "ok" and disarms the
    // interval, so no further probes fire.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(connectivitySnapshotForTests().server).toBe("ok");

    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a probe that itself throws (still offline) keeps retrying on schedule", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("network error"));
    vi.stubGlobal("fetch", fetchMock);

    reportRequestOutcome("network-error");
    reportRequestOutcome("network-error");

    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(connectivitySnapshotForTests().server).toBe("unreachable");
  });
});

describe("assertCanWrite", () => {
  it("does not throw when online and reachable", () => {
    expect(() => assertCanWrite()).not.toThrow();
  });

  it("throws the exact offline message when the device is offline", () => {
    setDeviceStateForTests("offline");
    expect(() => assertCanWrite()).toThrow(
      "Ei verkkoyhteyttä. Tämä toiminto vaatii yhteyden. Yritä uudelleen, kun yhteys palaa."
    );
  });

  it("throws the exact server-unreachable message once unreachable", () => {
    reportRequestOutcome("network-error");
    reportRequestOutcome("network-error");
    expect(() => assertCanWrite()).toThrow(
      "Palvelimeen ei saada yhteyttä. Tämä toiminto vaatii yhteyden. Yritä hetken kuluttua uudelleen."
    );
  });

  it("device-offline takes priority when both are true", () => {
    setDeviceStateForTests("offline");
    reportRequestOutcome("network-error");
    reportRequestOutcome("network-error");
    expect(() => assertCanWrite()).toThrow(/^Ei verkkoyhteyttä\./);
  });

  it("throws an OfflineError with that exact name", () => {
    setDeviceStateForTests("offline");
    try {
      assertCanWrite();
      expect.unreachable("assertCanWrite should have thrown");
    } catch (error) {
      expect((error as Error).name).toBe("OfflineError");
    }
  });
});

describe("isServerNewer", () => {
  it("null (never seen a response) is never newer", () => {
    expect(isServerNewer(null, 1)).toBe(false);
  });
  it("equal or older is not newer", () => {
    expect(isServerNewer(1, 1)).toBe(false);
    expect(isServerNewer(0, 1)).toBe(false);
  });
  it("a strictly greater server version is newer", () => {
    expect(isServerNewer(2, 1)).toBe(true);
  });
});
