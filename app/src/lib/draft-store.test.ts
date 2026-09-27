import { describe, expect, it } from "vitest";
import {
  clearDraft,
  DRAFT_TTL_MS,
  draftHasSecret,
  memoryDraftStorage,
  readDraft,
  resetDraftMemory,
  saveDraft,
} from "./draft-store";

describe("draft recovery", () => {
  it("stores form text and returns it inside the TTL", () => {
    resetDraftMemory();
    const now = 1_000;
    expect(saveDraft("invoice:new", { notes: "Ripsienpidennys" }, now, memoryDraftStorage)).toBe(true);
    expect(readDraft("invoice:new", now + 1000, memoryDraftStorage)?.value).toEqual({
      notes: "Ripsienpidennys",
    });
  });

  it("drops a draft after seven days", () => {
    resetDraftMemory();
    saveDraft("customer:new", { name: "Anna" }, 0, memoryDraftStorage);
    expect(readDraft("customer:new", DRAFT_TTL_MS + 1, memoryDraftStorage)).toBeNull();
    expect(memoryDraftStorage.get("lashkirja.draft.v1:customer:new")).toBeNull();
  });

  it("refuses secrets and file-like keys", () => {
    resetDraftMemory();
    expect(draftHasSecret({ password: "x" })).toBe(true);
    expect(draftHasSecret({ nested: { imapPass: "x" } })).toBe(true);
    expect(draftHasSecret({ iban: "FI2112345600000785" })).toBe(true);
    expect(saveDraft("receipt:1", { token: "abc" }, 0, memoryDraftStorage)).toBe(false);
    expect(readDraft("receipt:1", 0, memoryDraftStorage)).toBeNull();
  });

  it("clears a draft on discard", () => {
    resetDraftMemory();
    saveDraft("receipt:1", { vendor: "Tukku" }, 0, memoryDraftStorage);
    clearDraft("receipt:1", memoryDraftStorage);
    expect(readDraft("receipt:1", 0, memoryDraftStorage)).toBeNull();
  });
});
