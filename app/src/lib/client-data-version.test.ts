import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUMP_COALESCE_MS,
  DATA_VERSION_POLL_MS,
  bumpDataVersion,
  getDataVersion,
  noteServerVersion,
  resetDataVersion,
  startVersionPolling,
  subscribeDataVersion,
  versionSignature,
  type SyncVersionPayload,
} from "./client-data-version";

const payload = (dataVersion: number, extra: Partial<SyncVersionPayload> = {}): SyncVersionPayload => ({
  dataVersion,
  bank: { lastChangeAt: "2026-10-12T08:00:00Z", accounts: [{ bankAccountId: "a1", connectedAccountId: "c1", lastSyncAt: "2026-10-12T08:00:00Z", balanceCents: 12345 }] },
  receipts: { lastChangeAt: "2026-10-12T07:00:00Z" },
  invoices: { lastChangeAt: "2026-10-12T06:00:00Z" },
  ...extra,
});

beforeEach(() => {
  vi.useFakeTimers();
  resetDataVersion();
});
afterEach(() => {
  vi.useRealTimers();
  resetDataVersion();
});

describe("versionSignature", () => {
  it("changes with the counter, a balance, a sync time or an area marker", () => {
    const base = versionSignature(payload(1));
    expect(versionSignature(payload(2))).not.toBe(base);
    expect(
      versionSignature(payload(1, { bank: { accounts: [{ bankAccountId: "a1", connectedAccountId: "c1", lastSyncAt: "2026-10-12T08:00:00Z", balanceCents: 99 }] } }))
    ).not.toBe(base);
    expect(versionSignature(payload(1, { receipts: { lastChangeAt: "2026-10-12T09:00:00Z" } }))).not.toBe(base);
    expect(versionSignature(payload(1))).toBe(base);
  });

  it("is null for an answer that says nothing, never a crash", () => {
    expect(versionSignature(null)).toBeNull();
    expect(versionSignature({})).toBeNull();
    expect(versionSignature({ bank: { accounts: [] } })).toBeNull();
  });
});

describe("noteServerVersion", () => {
  it("records the first answer as the baseline and moves only when a later one differs", () => {
    expect(noteServerVersion(payload(1))).toBe(false);
    expect(getDataVersion()).toBe(0);
    expect(noteServerVersion(payload(1))).toBe(false);
    expect(noteServerVersion(payload(2))).toBe(true);
    expect(getDataVersion()).toBe(1);
  });

  it("ignores an answer without version information", () => {
    noteServerVersion(payload(1));
    expect(noteServerVersion({})).toBe(false);
    expect(getDataVersion()).toBe(0);
  });
});

describe("bumpDataVersion", () => {
  it("notifies subscribers once for a burst of saves", () => {
    const listener = vi.fn();
    subscribeDataVersion(listener);
    for (let i = 0; i < 40; i += 1) bumpDataVersion();
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(BUMP_COALESCE_MS);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getDataVersion()).toBe(1);
    bumpDataVersion();
    vi.advanceTimersByTime(BUMP_COALESCE_MS);
    expect(getDataVersion()).toBe(2);
  });

  it("stops notifying after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeDataVersion(listener);
    unsubscribe();
    bumpDataVersion();
    vi.advanceTimersByTime(BUMP_COALESCE_MS);
    expect(listener).not.toHaveBeenCalled();
  });
});

function pollerEnv(initialVisible = true) {
  let visible = initialVisible;
  const visibilityListeners = new Set<() => void>();
  const answers: Array<SyncVersionPayload | null> = [];
  const fetchVersion = vi.fn(async () => answers.shift() ?? null);
  return {
    fetchVersion,
    answers,
    env: {
      fetchVersion,
      isVisible: () => visible,
      onVisible: (callback: () => void) => {
        visibilityListeners.add(callback);
        return () => visibilityListeners.delete(callback);
      },
    },
    setVisible(next: boolean) {
      visible = next;
      for (const listener of [...visibilityListeners]) listener();
    },
    listenerCount: () => visibilityListeners.size,
  };
}

describe("startVersionPolling", () => {
  it("asks at once, then every 30 s, and bumps the version when the answer changes", async () => {
    const harness = pollerEnv();
    harness.answers.push(payload(1), payload(1), payload(2));
    const stop = startVersionPolling(harness.env);
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.fetchVersion).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(DATA_VERSION_POLL_MS);
    expect(harness.fetchVersion).toHaveBeenCalledTimes(2);
    expect(getDataVersion()).toBe(0);
    await vi.advanceTimersByTimeAsync(DATA_VERSION_POLL_MS);
    expect(harness.fetchVersion).toHaveBeenCalledTimes(3);
    expect(getDataVersion()).toBe(1);
    stop();
  });

  it("asks nothing while the tab is hidden and asks again the moment it is shown", async () => {
    const harness = pollerEnv();
    harness.answers.push(payload(1), payload(2));
    const stop = startVersionPolling(harness.env);
    await vi.advanceTimersByTimeAsync(0);
    harness.setVisible(false);
    await vi.advanceTimersByTimeAsync(DATA_VERSION_POLL_MS * 4);
    expect(harness.fetchVersion).toHaveBeenCalledTimes(1);
    harness.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.fetchVersion).toHaveBeenCalledTimes(2);
    expect(getDataVersion()).toBe(1);
    stop();
  });

  it("does not start while hidden at mount, and never doubles a poll that is still out", async () => {
    const hidden = pollerEnv(false);
    const stopHidden = startVersionPolling(hidden.env);
    await vi.advanceTimersByTimeAsync(DATA_VERSION_POLL_MS * 2);
    expect(hidden.fetchVersion).not.toHaveBeenCalled();
    stopHidden();

    let release: (value: SyncVersionPayload) => void = () => {};
    const slow = pollerEnv();
    slow.fetchVersion.mockImplementation(() => new Promise<SyncVersionPayload>((resolve) => (release = resolve)));
    const stop = startVersionPolling(slow.env);
    await vi.advanceTimersByTimeAsync(DATA_VERSION_POLL_MS * 3);
    expect(slow.fetchVersion).toHaveBeenCalledTimes(1);
    release(payload(1));
    stop();
  });

  it("survives a failing poll and stops cleanly", async () => {
    const harness = pollerEnv();
    harness.fetchVersion.mockRejectedValueOnce(new Error("offline"));
    harness.answers.push(payload(1));
    const stop = startVersionPolling(harness.env);
    await vi.advanceTimersByTimeAsync(DATA_VERSION_POLL_MS);
    expect(harness.fetchVersion).toHaveBeenCalledTimes(2);
    stop();
    expect(harness.listenerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(DATA_VERSION_POLL_MS * 3);
    expect(harness.fetchVersion).toHaveBeenCalledTimes(2);
  });
});
