import { describe, expect, it } from "vitest";
import {
  clearAllDrafts,
  clearDraft,
  currentDraftOwner,
  DRAFT_TTL_MS,
  draftHasSecret,
  memoryDraftStorage,
  readDraft,
  resetDraftMemory,
  saveDraft,
  scopedDraftKey,
  setDraftOwner,
} from "./draft-store";

describe("draft recovery", () => {
  it("stores form text and returns it inside the TTL", () => {
    resetDraftMemory();
    setDraftOwner("user-a", memoryDraftStorage);
    const now = 1_000;
    expect(saveDraft("invoice:new", { notes: "Ripsienpidennys" }, now, memoryDraftStorage)).toBe(true);
    expect(readDraft("invoice:new", now + 1000, memoryDraftStorage)?.value).toEqual({
      notes: "Ripsienpidennys",
    });
  });

  it("drops a draft after seven days", () => {
    resetDraftMemory();
    setDraftOwner("user-a", memoryDraftStorage);
    saveDraft("customer:new", { name: "Anna" }, 0, memoryDraftStorage);
    expect(readDraft("customer:new", DRAFT_TTL_MS + 1, memoryDraftStorage)).toBeNull();
    expect(memoryDraftStorage.get(`lashkirja.draft.v1:${scopedDraftKey("user-a", "customer:new")}`)).toBeNull();
  });

  it("does not restore one user's draft into another account", () => {
    resetDraftMemory();
    setDraftOwner("user-a", memoryDraftStorage);
    saveDraft("customer:new", { name: "Anna" }, 0, memoryDraftStorage);
    saveDraft("invoice:new", { notes: "A" }, 0, memoryDraftStorage);

    setDraftOwner("user-b", memoryDraftStorage);
    expect(readDraft("customer:new", 0, memoryDraftStorage)).toBeNull();
    expect(readDraft("invoice:new", 0, memoryDraftStorage)).toBeNull();
    expect(memoryDraftStorage.get(`lashkirja.draft.v1:${scopedDraftKey("user-a", "customer:new")}`)).toBeNull();

    expect(saveDraft("customer:new", { name: "Bertta" }, 0, memoryDraftStorage)).toBe(true);
    expect(readDraft("customer:new", 0, memoryDraftStorage)?.value).toEqual({ name: "Bertta" });
  });

  it("deletes unscoped keys instead of giving them to the next user", () => {
    resetDraftMemory();
    memoryDraftStorage.set(
      "lashkirja.draft.v1:receipt:new",
      JSON.stringify({ savedAt: 0, value: { vendor: "Anna" } })
    );
    setDraftOwner("user-b", memoryDraftStorage);
    expect(memoryDraftStorage.get("lashkirja.draft.v1:receipt:new")).toBeNull();
    expect(readDraft("receipt:new", 0, memoryDraftStorage)).toBeNull();
  });

  it("clears every draft on logout", () => {
    resetDraftMemory();
    setDraftOwner("user-a", memoryDraftStorage);
    saveDraft("receipt:new", { vendor: "Tukku" }, 0, memoryDraftStorage);
    clearAllDrafts(memoryDraftStorage);
    expect(currentDraftOwner()).toBeNull();
    expect(readDraft("receipt:new", 0, memoryDraftStorage)).toBeNull();
    expect(memoryDraftStorage.keys()).toEqual([]);
  });

  it("refuses secrets and file-like keys", () => {
    resetDraftMemory();
    setDraftOwner("user-a", memoryDraftStorage);
    expect(draftHasSecret({ password: "x" })).toBe(true);
    expect(draftHasSecret({ nested: { imapPass: "x" } })).toBe(true);
    expect(draftHasSecret({ iban: "FI2112345600000785" })).toBe(true);
    expect(saveDraft("receipt:1", { token: "abc" }, 0, memoryDraftStorage)).toBe(false);
    expect(readDraft("receipt:1", 0, memoryDraftStorage)).toBeNull();
  });

  it("clears a draft on discard", () => {
    resetDraftMemory();
    setDraftOwner("user-a", memoryDraftStorage);
    saveDraft("receipt:1", { vendor: "Tukku" }, 0, memoryDraftStorage);
    clearDraft("receipt:1", memoryDraftStorage);
    expect(readDraft("receipt:1", 0, memoryDraftStorage)).toBeNull();
  });
});
