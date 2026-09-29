import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import BottomSheet, { sheetDragOffset } from "./BottomSheet";

const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);

describe("BottomSheet", () => {
  it("carries overlay-root on its root element while open, so it survives .app-main's pointer-events lockout", () => {
    // Rendered outside .app-main here (no DOM, just markup), so this only
    // proves the class is present, not that pointer-events resolve inside a
    // real .app-frame[data-overlay="open"] - the browser probe in the task
    // report covers that half by clicking an actual menu item.
    const out = html(
      // eslint-disable-next-line react/no-children-prop -- non-JSX createElement call; BottomSheet's `children` is a required prop, so createElement's typing needs it in the props object rather than as a rest arg.
      createElement(BottomSheet, {
        isOpen: true,
        onClose: () => {},
        title: "Toiminnot",
        labelledBy: "t",
        children: createElement("button", { type: "button" }, "Avaa PDF"),
      })
    );
    // The root wrapper is the first div in the markup; overlay-root must be
    // on it (not merely somewhere in the tree) for globals.css's
    // `.app-main .overlay-root` rule to re-enable pointer events on the
    // whole sheet, backdrop included.
    const firstDivClass = /^<div class="([^"]*)"/.exec(out)?.[1] ?? "";
    expect(firstDivClass.split(" ")).toContain("overlay-root");
    expect(out).toContain("Avaa PDF");
  });

  it("renders nothing while closed", () => {
    const out = html(
      // eslint-disable-next-line react/no-children-prop -- see the note above.
      createElement(BottomSheet, { isOpen: false, onClose: () => {}, children: "hidden" })
    );
    expect(out).toBe("");
  });

  it("follows the finger down and resists asymptotically upward, never past 60 px (SHELL-03)", () => {
    expect(sheetDragOffset(120)).toBe(120);
    expect(sheetDragOffset(0)).toBe(0);
    const lifts = [100, 200, 400, 600, 5000].map((pull) => -sheetDragOffset(-pull));
    for (let i = 1; i < lifts.length; i++) expect(lifts[i]).toBeGreaterThan(lifts[i - 1]);
    expect(Math.max(...lifts)).toBeLessThan(60);
  });

  it("puts a canvas bleed under the panel so a lift never shows the tab bar", () => {
    const out = html(
      // eslint-disable-next-line react/no-children-prop -- see the note above.
      createElement(BottomSheet, { isOpen: true, onClose: () => {}, title: "Lisää", children: "x" })
    );
    expect(out).toContain('class="sheet-bleed"');
    // The title takes initial focus without a ring (SHELL-29).
    expect(out).toMatch(/<p[^>]*tabindex="-1"[^>]*>Lisää<\/p>/);
  });
});
