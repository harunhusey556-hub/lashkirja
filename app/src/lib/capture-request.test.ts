import { describe, expect, it } from "vitest";
import { captureReceiptHref } from "./capture-request";

describe("receipt capture's chosen bank row", () => {
  it("preserves the bank row when the camera hands files to the editor", () => {
    expect(captureReceiptHref({ transactionId: "bank-row-1" })).toBe("/kuitit/uusi?from=camera&transactionId=bank-row-1");
  });
  it("preserves the bank row when the native camera is unavailable", () => {
    expect(captureReceiptHref({ transactionId: "bank-row-1" }, false)).toBe("/kuitit/uusi?transactionId=bank-row-1");
  });
  it("leaves ordinary capture without a previous bank-row target", () => {
    expect(captureReceiptHref()).toBe("/kuitit/uusi?from=camera");
    expect(captureReceiptHref(undefined, false)).toBe("/kuitit/uusi");
  });
  it("encodes the target so it cannot introduce another query flag", () => {
    const url = new URL(captureReceiptHref({ transactionId: "row&from=other" }), "http://localhost");
    expect(url.searchParams.get("transactionId")).toBe("row&from=other");
    expect(url.searchParams.get("from")).toBe("camera");
  });
});
