import { describe, expect, it } from "vitest";
import { isUnreadableNote, UNREADABLE_RECEIPT_NOTE } from "./receipt-unreadable";

describe("isUnreadableNote (V13)", () => {
  it("knows the current note and the one older pending receipts still carry", () => {
    expect(isUnreadableNote(UNREADABLE_RECEIPT_NOTE)).toBe(true);
    expect(isUnreadableNote("Tietoja ei saatu luettua kuvasta. Täydennä käsin.")).toBe(true);
  });

  it("is false for the user's own note and for nothing", () => {
    expect(isUnreadableNote("Lounas asiakkaan kanssa")).toBe(false);
    expect(isUnreadableNote("")).toBe(false);
    expect(isUnreadableNote(null)).toBe(false);
    expect(isUnreadableNote(undefined)).toBe(false);
  });
});
