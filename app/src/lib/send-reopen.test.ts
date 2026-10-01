import { describe, expect, it } from "vitest";
import { rememberSendReopen, SEND_REOPEN_MAX_AGE_MS, takeSendReopen } from "./send-reopen";

function memoryStore() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
}

describe("the send sheet reopens after the owner fixed what blocked it (F22)", () => {
  it("reopens once for the same invoice", () => {
    const store = memoryStore();
    rememberSendReopen("inv-1", 1_000, store);
    expect(takeSendReopen("inv-1", 2_000, store)).toBe(true);
    expect(takeSendReopen("inv-1", 2_000, store)).toBe(false);
  });

  it("never opens for another invoice, and the note is spent either way", () => {
    const store = memoryStore();
    rememberSendReopen("inv-1", 1_000, store);
    expect(takeSendReopen("inv-2", 2_000, store)).toBe(false);
    expect(takeSendReopen("inv-1", 2_000, store)).toBe(false);
  });

  it("ignores an old note", () => {
    const store = memoryStore();
    rememberSendReopen("inv-1", 0, store);
    expect(takeSendReopen("inv-1", SEND_REOPEN_MAX_AGE_MS + 1, store)).toBe(false);
  });

  it("does nothing without storage or with a broken note", () => {
    expect(takeSendReopen("inv-1", 0, null)).toBe(false);
    const store = memoryStore();
    store.setItem("lashkirja.reopen-send", "{not json");
    expect(takeSendReopen("inv-1", 0, store)).toBe(false);
  });
});
