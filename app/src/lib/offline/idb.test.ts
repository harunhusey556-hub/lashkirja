import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openIndexedDbLike, resetIdbForTests } from "./idb";

/**
 * Final review M1: `getDb()` used to memoize `dbPromise` on a rejection
 * exactly like a success, so one transient open failure (another
 * tab/webview holding a blocking version-change transaction, a momentary
 * OS storage hiccup) permanently degraded the app to memory-only for the
 * rest of that launch, even after the underlying cause cleared. This file
 * installs a fake `indexedDB` global whose first `open()` call can be made
 * to fail, then verifies `openIndexedDbLike()` retries on its very next
 * call rather than reusing the same dead promise -- and that a genuinely
 * successful open still only opens the database once.
 */

type Handler = (() => void) | null;

interface FakeRequest {
  result?: unknown;
  error?: Error;
  onsuccess: Handler;
  onerror: Handler;
  onupgradeneeded: Handler;
  onblocked: Handler;
}

/** Installs a fake `indexedDB.open()`. When `failFirstCall` is true, the
 * very first call's request rejects (onerror); every call after that (or
 * every call at all, if false) succeeds. Returns how many times `open()`
 * was actually invoked, so a test can assert a memoized success is never
 * re-opened. */
function installFakeIndexedDb(failFirstCall: boolean): () => number {
  let openCallCount = 0;
  const fakeDb = { objectStoreNames: { contains: () => true } };
  (globalThis as { indexedDB?: unknown }).indexedDB = {
    open(): FakeRequest {
      openCallCount += 1;
      const isFailingCall = failFirstCall && openCallCount === 1;
      const request: FakeRequest = { onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      queueMicrotask(() => {
        request.result = fakeDb;
        request.onupgradeneeded?.();
        if (isFailingCall) {
          request.error = new Error("transient IndexedDB open failure");
          request.onerror?.();
        } else {
          request.onsuccess?.();
        }
      });
      return request;
    },
  };
  return () => openCallCount;
}

describe("openIndexedDbLike / getDb: M1 -- a transient open failure is not memoized", () => {
  beforeEach(() => {
    resetIdbForTests();
  });

  afterEach(() => {
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
    resetIdbForTests();
  });

  it("returns null on a failing open, then succeeds on the very next call", async () => {
    installFakeIndexedDb(true);

    const first = await openIndexedDbLike();
    expect(first).toBeNull();

    const second = await openIndexedDbLike();
    expect(second).not.toBeNull();
  });

  it("a genuinely successful open is still memoized -- indexedDB.open() is called only once", async () => {
    const getOpenCallCount = installFakeIndexedDb(false);

    await openIndexedDbLike();
    await openIndexedDbLike();
    await openIndexedDbLike();

    expect(getOpenCallCount()).toBe(1);
  });

  it("after a failure and a successful retry, later calls reuse that success (no further re-opens)", async () => {
    const getOpenCallCount = installFakeIndexedDb(true);

    await openIndexedDbLike(); // fails: open() call #1
    await openIndexedDbLike(); // retries and succeeds: open() call #2
    await openIndexedDbLike(); // reuses the memoized success: no #3

    expect(getOpenCallCount()).toBe(2);
  });
});
