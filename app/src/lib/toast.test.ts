import { afterEach, describe, expect, it, vi } from "vitest";
import {
  currentToast,
  defaultToastDuration,
  dismissToast,
  resetToastsForTests,
  showToast,
  subscribeToasts,
} from "./toast";

afterEach(() => resetToastsForTests());

describe("toast store", () => {
  it("shows one toast at a time and tells the replaced one why it left", () => {
    const first = vi.fn();
    showToast({ text: "Kuitti tallennettu", tone: "success", onDismiss: first });
    showToast({ text: "Lasku lähetetty", tone: "success" });
    expect(currentToast()?.text).toBe("Lasku lähetetty");
    expect(first).toHaveBeenCalledWith("replaced");
  });

  it("returns a dismiss that only closes its own toast", () => {
    const dismissFirst = showToast({ text: "A" });
    showToast({ text: "B" });
    dismissFirst();
    expect(currentToast()?.text).toBe("B");
  });

  it("reports the reason to onDismiss (undo pattern commits unless reason is action)", () => {
    const onDismiss = vi.fn();
    showToast({ text: "Poistettu", action: { label: "Kumoa", onAction: () => {} }, onDismiss });
    dismissToast(undefined, "action");
    expect(onDismiss).toHaveBeenCalledWith("action");
    expect(currentToast()).toBeNull();
  });

  it("notifies subscribers", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToasts(listener);
    showToast({ text: "A" });
    dismissToast();
    unsubscribe();
    showToast({ text: "B" });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("keeps errors and actionable toasts up longer", () => {
    expect(defaultToastDuration("success", false)).toBe(4000);
    expect(defaultToastDuration("error", false)).toBe(8000);
    expect(defaultToastDuration("info", true)).toBe(10000);
    expect(defaultToastDuration("error", true)).toBe(10000);
    showToast({ text: "Pysyy", durationMs: 0 });
    expect(currentToast()?.durationMs).toBe(0);
  });
});
