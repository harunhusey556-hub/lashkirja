import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PasswordField, captureSelection, restoreSelection, wasInputFocused } from "./PasswordField";

const html = (props: Record<string, unknown>) =>
  renderToStaticMarkup(createElement(PasswordField, { id: "pw", label: "Salasana", ...props }));

describe("PasswordField", () => {
  it("renders a labelled password input and a 44 px eye button named for the action", () => {
    const out = html({ autoComplete: "current-password" });
    expect(out).toContain('<label for="pw"');
    expect(out).toMatch(/<input[^>]*id="pw"[^>]*type="password"|<input[^>]*type="password"[^>]*id="pw"/);
    expect(out).toContain('autoComplete="current-password"');
    expect(out).toContain('aria-label="Näytä salasana"');
    expect(out).toContain("h-11");
    expect(out).toContain("w-11");
    expect(out).toContain('type="button"');
  });

  it("keeps autofill hostile features off by default", () => {
    const out = html({});
    expect(out).toContain('autoCapitalize="none"');
    expect(out).toContain('autoCorrect="off"');
    expect(out).toContain('spellCheck="false"');
  });

  it("shows an inline alert under the field and ties it to the input", () => {
    const out = html({ error: "Salasanat eivät täsmää." });
    expect(out).toContain('role="alert"');
    expect(out).toContain('id="pw-error"');
    expect(out).toContain('aria-invalid="true"');
    expect(out).toContain('aria-describedby="pw-error"');
    expect(out).toContain("!border-danger");
  });

  it("shows the hint only while there is no error", () => {
    expect(html({ hint: "Vähintään 10 merkkiä." })).toContain("Vähintään 10 merkkiä.");
    expect(html({ hint: "Vähintään 10 merkkiä.", error: "Liian lyhyt." })).not.toContain("Vähintään 10 merkkiä.");
  });

  it("lets a PIN field rename the toggle and forwards numeric input attributes", () => {
    const out = html({
      showLabel: "Näytä koodi",
      hideLabel: "Piilota koodi",
      inputMode: "numeric",
      maxLength: 8,
    });
    expect(out).toContain('aria-label="Näytä koodi"');
    expect(out).toContain('inputMode="numeric"');
    expect(out).toContain('maxLength="8"');
  });

  it("reserves room for the eye so long text never runs under it", () => {
    expect(html({})).toContain("padding-right:48px");
  });
});

describe("the eye toggle on touch (F07)", () => {
  const source = readFileSync(join(__dirname, "PasswordField.tsx"), "utf8");

  it("never cancels the pointer events, so a touch tap still produces the click that toggles", () => {
    // A cancelled touch pointerdown suppresses the compatibility mousedown/mouseup/click in WebKit
    // touch emulation. Focus is kept by the mousedown handler and by restoring it after the toggle.
    expect(source).not.toMatch(/onPointerDown={[^}]*preventDefault/);
    expect(source).not.toMatch(/onTouchStart={[^}]*preventDefault/);
    expect(source).toContain("onClick={(event) => toggle(event.detail === 0)}");
  });

  function fakeInput(selection: { start: number | null; end: number | null }, value = "hemmo123") {
    const calls: string[] = [];
    return {
      value,
      selectionStart: selection.start,
      selectionEnd: selection.end,
      calls,
      focus(options?: { preventScroll?: boolean }) {
        calls.push(`focus:${options?.preventScroll}`);
      },
      setSelectionRange(start: number, end: number) {
        calls.push(`range:${start}-${end}`);
      },
    };
  }

  it("captures the caret and whether the field was focused", () => {
    const input = fakeInput({ start: 2, end: 5 });
    expect(captureSelection(input, true)).toEqual({ start: 2, end: 5, focused: true });
    expect(captureSelection(fakeInput({ start: null, end: null }), false)).toEqual({ start: 8, end: 8, focused: false });
  });

  it("puts focus and the selection back on a field that had them", () => {
    const input = fakeInput({ start: 2, end: 5 });
    restoreSelection(input, { start: 2, end: 5, focused: true });
    expect(input.calls).toEqual(["focus:true", "range:2-5"]);
  });

  it("leaves a field alone that was not focused", () => {
    const input = fakeInput({ start: 2, end: 5 });
    restoreSelection(input, { start: 2, end: 5, focused: false });
    expect(input.calls).toEqual([]);
    expect(() => restoreSelection(null, { start: 0, end: 0, focused: true })).not.toThrow();
  });
});

describe("wasInputFocused (V50)", () => {
  it("trusts the press-time hint for a pointer click, where the tap itself blurs the input", () => {
    expect(wasInputFocused({ pressHint: true, inputIsActive: false, fromKeyboard: false })).toBe(true);
    expect(wasInputFocused({ pressHint: false, inputIsActive: false, fromKeyboard: false })).toBe(false);
  });

  it("ignores a hint left over from an aborted press when the eye is activated by keyboard or assistive technology", () => {
    expect(wasInputFocused({ pressHint: true, inputIsActive: false, fromKeyboard: true })).toBe(false);
    expect(wasInputFocused({ pressHint: true, inputIsActive: true, fromKeyboard: true })).toBe(true);
  });
});
