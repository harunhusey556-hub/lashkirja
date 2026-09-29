import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PasswordField } from "./PasswordField";

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
