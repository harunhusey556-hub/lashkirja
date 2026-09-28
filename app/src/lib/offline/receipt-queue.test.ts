import { describe, expect, it } from "vitest";
import type { IdbLike } from "./idb";
import {
  classifySendResult,
  clearReceiptQueueStore,
  deleteQueuedReceipt,
  earliestNextAttemptAt,
  enqueueReceipt,
  listQueuedReceipts,
  nextAttemptDelayMs,
  pickNextQueued,
  pruneDoneReceipts,
  recoverCrashedSends,
  saveQueuedReceipt,
  type QueuedReceipt,
} from "./receipt-queue";

/** In-memory stand-in for idb.ts's real IndexedDB adapter, same shape
 * persistent-cache.test.ts uses for its own store. */
function createFakeIdb(): IdbLike {
  const stores = new Map<string, Map<string, unknown>>();
  function storeFor(name: string): Map<string, unknown> {
    let store = stores.get(name);
    if (!store) {
      store = new Map();
      stores.set(name, store);
    }
    return store;
  }
  return {
    async get<T>(store: string, key: string) {
      return storeFor(store).get(key) as T | undefined;
    },
    async getAll<T>(store: string) {
      return [...storeFor(store).values()] as T[];
    },
    async put<T>(store: string, value: T) {
      const row = value as unknown as { id: string };
      storeFor(store).set(row.id, value);
    },
    async delete(store: string, key: string) {
      storeFor(store).delete(key);
    },
    async clear(store: string) {
      storeFor(store).clear();
    },
  };
}

function makeItem(overrides: Partial<QueuedReceipt> = {}): QueuedReceipt {
  return {
    id: "id-1",
    userId: "u1",
    createdAt: 0,
    capturedAt: new Date(0).toISOString(),
    fileName: "kuitti.jpg",
    mimeType: "image/jpeg",
    size: 10,
    iv: new Uint8Array(12),
    data: new ArrayBuffer(10),
    status: "queued",
    attempts: 0,
    nextAttemptAt: 0,
    ...overrides,
  };
}

describe("nextAttemptDelayMs", () => {
  it("follows the 5s / 30s / 2min / 10min / 30min schedule", () => {
    expect(nextAttemptDelayMs(1)).toBe(5_000);
    expect(nextAttemptDelayMs(2)).toBe(30_000);
    expect(nextAttemptDelayMs(3)).toBe(2 * 60_000);
    expect(nextAttemptDelayMs(4)).toBe(10 * 60_000);
    expect(nextAttemptDelayMs(5)).toBe(30 * 60_000);
  });

  it("plateaus at 30 minutes for every attempt past the 5th", () => {
    expect(nextAttemptDelayMs(6)).toBe(30 * 60_000);
    expect(nextAttemptDelayMs(20)).toBe(30 * 60_000);
  });

  it("treats 0 or negative attempts like the first", () => {
    expect(nextAttemptDelayMs(0)).toBe(5_000);
    expect(nextAttemptDelayMs(-3)).toBe(5_000);
  });
});

describe("classifySendResult", () => {
  it("maps 2xx to done", () => {
    expect(classifySendResult(200)).toBe("done");
    expect(classifySendResult(201)).toBe("done");
    expect(classifySendResult(299)).toBe("done");
  });

  it("maps 401 to paused", () => {
    expect(classifySendResult(401)).toBe("paused");
  });

  it("maps 408, 429 and 5xx to retry", () => {
    expect(classifySendResult(408)).toBe("retry");
    expect(classifySendResult(429)).toBe("retry");
    expect(classifySendResult(500)).toBe("retry");
    expect(classifySendResult(503)).toBe("retry");
  });

  it("maps a network error to retry", () => {
    expect(classifySendResult("network-error")).toBe("retry");
  });

  it("maps every other 4xx to failed", () => {
    expect(classifySendResult(400)).toBe("failed");
    expect(classifySendResult(413)).toBe("failed");
    expect(classifySendResult(415)).toBe("failed");
    expect(classifySendResult(422)).toBe("failed");
  });
});

describe("pickNextQueued", () => {
  it("picks the oldest queued item whose nextAttemptAt has arrived", () => {
    const items = [
      makeItem({ id: "b", createdAt: 200, nextAttemptAt: 0 }),
      makeItem({ id: "a", createdAt: 100, nextAttemptAt: 0 }),
    ];
    expect(pickNextQueued(items, 1_000)?.id).toBe("a");
  });

  it("skips a queued item whose nextAttemptAt is still in the future", () => {
    const items = [makeItem({ id: "a", nextAttemptAt: 5_000 })];
    expect(pickNextQueued(items, 1_000)).toBeNull();
  });

  it("never picks a failed, sending or done item", () => {
    const items = [
      makeItem({ id: "a", status: "failed" }),
      makeItem({ id: "b", status: "sending" }),
      makeItem({ id: "c", status: "done" }),
    ];
    expect(pickNextQueued(items, 1_000)).toBeNull();
  });

  it("returns null for an empty queue", () => {
    expect(pickNextQueued([], 1_000)).toBeNull();
  });
});

describe("earliestNextAttemptAt", () => {
  it("returns the smallest nextAttemptAt among queued items", () => {
    const items = [
      makeItem({ id: "a", nextAttemptAt: 5_000 }),
      makeItem({ id: "b", nextAttemptAt: 2_000 }),
      makeItem({ id: "c", status: "failed", nextAttemptAt: 0 }),
    ];
    expect(earliestNextAttemptAt(items)).toBe(2_000);
  });

  it("returns null when nothing is queued", () => {
    expect(earliestNextAttemptAt([makeItem({ status: "done" })])).toBeNull();
  });

  it("returns null for an empty list", () => {
    expect(earliestNextAttemptAt([])).toBeNull();
  });
});

describe("enqueueReceipt + listQueuedReceipts: round trip and ordering", () => {
  it("encrypts the file bytes and lists rows oldest-first, scoped to one user", async () => {
    const idb = createFakeIdb();
    const file = new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/jpeg" });

    const second = await enqueueReceipt(
      { userId: "u1", file, fileName: "b.jpg", mimeType: "image/jpeg", capturedAt: new Date(200).toISOString() },
      idb
    );
    // Force distinct createdAt values without relying on real timing.
    await saveQueuedReceipt({ ...second!, createdAt: 200 }, idb);

    const first = await enqueueReceipt(
      { userId: "u1", file, fileName: "a.jpg", mimeType: "image/jpeg", capturedAt: new Date(100).toISOString() },
      idb
    );
    await saveQueuedReceipt({ ...first!, createdAt: 100 }, idb);

    await enqueueReceipt(
      { userId: "u2", file, fileName: "other-user.jpg", mimeType: "image/jpeg", capturedAt: new Date(50).toISOString() },
      idb
    );

    const rows = await listQueuedReceipts("u1", idb);
    expect(rows.map((r) => r.fileName)).toEqual(["a.jpg", "b.jpg"]);
    expect(rows[0].status).toBe("queued");
    expect(rows[0].attempts).toBe(0);
    expect(rows[0].size).toBe(4);
    // The stored bytes are ciphertext, not the plaintext [1,2,3,4].
    expect(new Uint8Array(rows[0].data)).not.toEqual(new Uint8Array([1, 2, 3, 4]));
  });
});

describe("recoverCrashedSends", () => {
  it("puts a stuck sending row for this user back to queued", async () => {
    const idb = createFakeIdb();
    await saveQueuedReceipt(
      { ...makeItem({ id: "a", userId: "u1", status: "sending" }) },
      idb
    );
    await saveQueuedReceipt(
      { ...makeItem({ id: "b", userId: "u1", status: "queued" }) },
      idb
    );
    // A different user's own "sending" row must be left alone.
    await saveQueuedReceipt(
      { ...makeItem({ id: "c", userId: "u2", status: "sending" }) },
      idb
    );

    await recoverCrashedSends("u1", idb);

    const rows = await listQueuedReceipts("u1", idb);
    expect(rows.find((r) => r.id === "a")?.status).toBe("queued");
    expect(rows.find((r) => r.id === "b")?.status).toBe("queued");
    const otherUserRow = await idb.get<QueuedReceipt>("receipt-queue", "c");
    expect(otherUserRow?.status).toBe("sending");
  });
});

describe("pruneDoneReceipts", () => {
  it("deletes a done row older than 24h and keeps a recent one", async () => {
    const idb = createFakeIdb();
    const dayMs = 24 * 60 * 60 * 1000;
    await saveQueuedReceipt(makeItem({ id: "old", userId: "u1", status: "done", createdAt: 0 }), idb);
    await saveQueuedReceipt(
      makeItem({ id: "recent", userId: "u1", status: "done", createdAt: dayMs - 1_000 }),
      idb
    );
    await saveQueuedReceipt(makeItem({ id: "queued", userId: "u1", status: "queued", createdAt: 0 }), idb);

    await pruneDoneReceipts("u1", dayMs + 1, idb);

    const rows = await listQueuedReceipts("u1", idb);
    expect(rows.map((r) => r.id).sort()).toEqual(["queued", "recent"]);
  });
});

describe("deleteQueuedReceipt", () => {
  it("removes only the named row", async () => {
    const idb = createFakeIdb();
    await saveQueuedReceipt(makeItem({ id: "a" }), idb);
    await saveQueuedReceipt(makeItem({ id: "b" }), idb);

    await deleteQueuedReceipt("a", idb);

    const rows = await listQueuedReceipts("u1", idb);
    expect(rows.map((r) => r.id)).toEqual(["b"]);
  });
});

describe("clearReceiptQueueStore", () => {
  it("removes every row from the store", async () => {
    const idb = createFakeIdb();
    await saveQueuedReceipt(makeItem({ id: "a" }), idb);
    await saveQueuedReceipt(makeItem({ id: "b" }), idb);

    await clearReceiptQueueStore(idb);

    expect(await listQueuedReceipts("u1", idb)).toEqual([]);
  });
});
