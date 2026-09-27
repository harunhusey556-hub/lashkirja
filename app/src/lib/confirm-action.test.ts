import { describe, expect, it } from "vitest";
import { CONFIRM_FAILED, settleConfirm } from "./confirm-action";

describe("settleConfirm", () => {
  it("closes after an async action resolves", async () => {
    let finished = false;
    const outcome = await settleConfirm(async () => {
      await Promise.resolve();
      finished = true;
    });
    expect(finished).toBe(true);
    expect(outcome).toEqual({ close: true });
  });

  it("stays open with the error so the user can retry", async () => {
    const outcome = await settleConfirm(async () => {
      throw new Error("Poisto epäonnistui");
    });
    expect(outcome).toEqual({ close: false, message: "Poisto epäonnistui" });
  });

  it("uses a fallback message when the rejection has none", async () => {
    const outcome = await settleConfirm(() => Promise.reject(new Error("  ")));
    expect(outcome).toEqual({ close: false, message: CONFIRM_FAILED });
  });
});
