import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onReconnectDebounced } from "./useRefetchOnReconnect";

describe("onReconnectDebounced", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("calls back once after a burst of reconnect events", () => {
    const target = new EventTarget();
    const callback = vi.fn();
    onReconnectDebounced(target, callback, 400);
    target.dispatchEvent(new Event("lashkirja-reconnected"));
    target.dispatchEvent(new Event("lashkirja-reconnected"));
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(400);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("does nothing after unsubscribe, even with a pending timer", () => {
    const target = new EventTarget();
    const callback = vi.fn();
    const stop = onReconnectDebounced(target, callback, 400);
    target.dispatchEvent(new Event("lashkirja-reconnected"));
    stop();
    vi.advanceTimersByTime(1000);
    target.dispatchEvent(new Event("lashkirja-reconnected"));
    vi.advanceTimersByTime(1000);
    expect(callback).not.toHaveBeenCalled();
  });
});
