import { describe, expect, it } from "vitest";
import { usableArea } from "./usable-area";

describe("usableArea", () => {
  it("pads the notch once when the frame starts at the top of the screen", () => {
    const area = usableArea({
      innerHeight: 844,
      offsetTop: 0,
      viewportHeight: 844,
      envTop: 59,
      envBottom: 34,
    });
    expect(area.frameTop).toBe(0);
    expect(area.safeTop).toBe(59);
    expect(area.safeBottom).toBe(34);
    expect(area.safeTop + area.frameTop).toBe(59);
  });

  it("does not pad the header again when offsetTop already cleared the notch", () => {
    const area = usableArea({
      innerHeight: 844,
      offsetTop: 59,
      viewportHeight: 785,
      envTop: 59,
      envBottom: 34,
    });
    expect(area.frameTop).toBe(59);
    expect(area.safeTop).toBe(0);
    expect(area.safeTop + area.frameTop).toBe(59);
  });

  it("treats a keyboard as a shorter frame, not as a safe-area inset", () => {
    const area = usableArea({
      innerHeight: 844,
      offsetTop: 0,
      viewportHeight: 520,
      envTop: 59,
      envBottom: 34,
    });
    expect(area.keyboardOpen).toBe(true);
    expect(area.frameHeight).toBe(520);
    expect(area.safeTop).toBe(59);
    expect(area.safeBottom).toBe(0);
  });

  it("does not add the home indicator when the frame already ends above it", () => {
    const area = usableArea({
      innerHeight: 844,
      offsetTop: 0,
      viewportHeight: 810,
      envTop: 0,
      envBottom: 34,
    });
    expect(area.keyboardOpen).toBe(false);
    expect(area.safeBottom).toBe(0);
  });
});
