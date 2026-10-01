import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(__dirname, "globals.css"), "utf8").replace(/\r\n/g, "\n");

/** The declaration block of the rule that starts with exactly this selector. */
function declarations(selector: string): string | null {
  const start = css.indexOf(`\n${selector} {`);
  if (start === -1) return null;
  return css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
}

describe("the heading focused after a navigation (F92, G40)", () => {
  it("never draws a ring, whatever :focus-visible says", () => {
    // WebKit treats the script focus() of the h1 as focus-visible (touch emulation and the iOS
    // simulator), so a `:not(:focus-visible)` guard still shows the heavy frame. The heading is not
    // interactive and not tab-reachable; the focus move is for screen readers only.
    const block = declarations('main h1[tabindex="-1"]:focus');
    expect(block).not.toBeNull();
    expect(block).toMatch(/outline:\s*none/);
    expect(css).not.toContain(':focus:not(:focus-visible)');
  });
});
