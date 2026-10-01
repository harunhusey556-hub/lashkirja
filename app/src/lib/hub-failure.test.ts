import { describe, expect, it } from "vitest";
import { firstHubFailure } from "./hub-failure";

describe("firstHubFailure", () => {
  it("is null when everything loaded or a failed slot still has a cached value", () => {
    expect(firstHubFailure([{ failed: false, empty: true }, { failed: true, empty: false }])).toBeNull();
  });

  it("returns the first failed slot that has nothing to show", () => {
    const boom = new Error("boom");
    expect(
      firstHubFailure([
        { failed: true, empty: false },
        { failed: true, empty: true, error: boom },
        { failed: true, empty: true, error: new Error("later") },
      ])
    ).toEqual({ error: boom });
  });

  it("gives a failed slot without an error object a generic error", () => {
    expect(firstHubFailure([{ failed: true, empty: true }])?.error).toBeInstanceOf(Error);
  });
});
