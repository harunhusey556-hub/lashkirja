import { describe, expect, it } from "vitest";
import { appLockMatches, createAppLockRecord } from "./app-lock";
import { deviceLabel, logoutOutcome, nextLockView, passwordProblem } from "./session-policy";

describe("account policy", () => {
  it("requires a password of at least 10 characters", () => {
    expect(passwordProblem("lyhyt")).toMatch(/10/);
    expect(passwordProblem("tarpeeksi-pitka")).toBeNull();
  });

  it("names a device without keeping the raw user agent", () => {
    expect(deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit Safari/605")).toBe(
      "iPhone · Safari"
    );
    expect(deviceLabel("Mozilla/5.0 (Linux) Chrome/120")).toBe("Linux · Chrome");
    expect(deviceLabel("iPhone Safari/605")).not.toContain("Mozilla");
  });

  it("stays on the page when logout fails", () => {
    expect(logoutOutcome(false)).toBe("stay");
    expect(logoutOutcome(true)).toBe("login");
  });

  it("covers the screen when a local lock is backgrounded and does not open without the code", () => {
    expect(nextLockView(false, "hide")).toBe("open");
    expect(nextLockView(true, "hide")).toBe("covered");
    expect(nextLockView(true, "show")).toBe("locked");
    expect(nextLockView(true, "unlock")).toBe("open");
  });

  it("accepts only the pin that was stored", async () => {
    const record = await createAppLockRecord("1234");
    expect(record).not.toBeNull();
    expect(await appLockMatches(record!, "1234")).toBe(true);
    expect(await appLockMatches(record!, "9999")).toBe(false);
    expect(await createAppLockRecord("12")).toBeNull();
    expect(record!.hash).not.toContain("1234");
  });
});
