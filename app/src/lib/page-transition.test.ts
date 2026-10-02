import { afterEach, describe, expect, it, vi } from "vitest";
import { playNavTransition } from "./page-transition";

afterEach(() => vi.unstubAllGlobals());

describe("navigation content handoff", () => {
  it.each([
    { kind: "tab" as const, reduced: false },
    { kind: "push" as const, reduced: true },
    { kind: "pop" as const, reduced: true },
  ])("does not remount outgoing text for $kind (reduced=$reduced)", ({ kind, reduced }) => {
    vi.stubGlobal("window", { matchMedia: () => ({ matches: reduced }) });
    const animate = vi.fn(() => ({ finished: new Promise(() => {}), cancel: vi.fn() }));
    const parentElement = { appendChild: vi.fn() };
    const main = { animate, parentElement, dataset: {}, style: {} as CSSStyleDeclaration, dispatchEvent: vi.fn() } as unknown as HTMLElement;
    const cancel = playNavTransition({ main, oldPage: {} as HTMLElement, oldScroll: 120, kind });
    // Only the incoming page fades in: the old page is never shown again.
    expect(parentElement.appendChild).not.toHaveBeenCalled();
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate.mock.calls[0]).toEqual([[{ opacity: 0 }, { opacity: 1 }], expect.anything()]);
    cancel();
    expect(main.dataset.navMoving).toBeUndefined();
    // The fade's own compositing layer is dropped with it.
    expect(main.style.willChange || "").toBe("");
  });
});

it("holds a form refresh until prepared navigation layers are removed", async () => {
  const main = new EventTarget();
  vi.stubGlobal("document", { querySelector: () => main });
  vi.stubGlobal("window", { setTimeout, clearTimeout });
  const { whenNavigationSettles } = await import("./page-transition");
  let settled = false;
  const waiting = whenNavigationSettles().then(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);
  main.dispatchEvent(new Event("lashkirja-nav-settled"));
  await waiting;
  expect(settled).toBe(true);
});
