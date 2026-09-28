import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import BottomSheet from "./BottomSheet";

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
});
