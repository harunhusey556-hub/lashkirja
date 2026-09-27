import { describe, expect, it } from "vitest";
import { motionFeedback } from "./motion-feedback";

describe("reduced motion", () => {
  it("drops animation, shimmer, and haptics together", () => {
    expect(motionFeedback(true)).toEqual({
      animate: false,
      shimmer: false,
      haptic: false,
      pressed: true,
      statusText: true,
    });
  });

  it("keeps motion and haptics when the user has not asked to reduce them", () => {
    expect(motionFeedback(false)).toEqual({
      animate: true,
      shimmer: true,
      haptic: true,
      pressed: true,
      statusText: true,
    });
  });
});
