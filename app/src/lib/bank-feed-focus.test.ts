import { describe, expect, it } from "vitest";
import { focusRowId } from "./bank-feed-focus";

const rows = [{ id: "a" }, { id: "b" }];

describe("bank feed ?rivi= focus", () => {
  it("opens the asked row once it has loaded", () => {
    expect(focusRowId("b", rows, false)).toBe("b");
  });

  it("waits while the row is not in the loaded rows", () => {
    expect(focusRowId("x", rows, false)).toBeNull();
  });

  it("opens it only once, so closing the sheet sticks", () => {
    expect(focusRowId("b", rows, true)).toBeNull();
  });

  it("does nothing without the parameter", () => {
    expect(focusRowId(null, rows, false)).toBeNull();
    expect(focusRowId("", rows, false)).toBeNull();
  });
});
