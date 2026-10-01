import { describe, expect, it } from "vitest";
import { CLOSE_REQUEST_MESSAGE, forgotPasswordMessage, reportCopiedToast, supportContactLine } from "./account-copy";

describe("forgotPasswordMessage", () => {
  it("never claims a link is on its way when the server cannot send mail", () => {
    const text = forgotPasswordMessage(false, "tuki@example.fi");
    expect(text).not.toMatch(/matkalla|lähetettiin/);
    expect(text).toContain("tuki@example.fi");
    expect(text).toMatch(/tukeen/);
  });

  it("tells a signed-out user to go to support, not to a signed-in screen", () => {
    expect(forgotPasswordMessage(false, "")).not.toMatch(/Tietosuoja|kun kirjaudut/);
    expect(forgotPasswordMessage(true, "")).not.toMatch(/Tietosuoja|kun kirjaudut/);
  });

  it("says the link is on its way only when mail is configured", () => {
    expect(forgotPasswordMessage(true, "")).toMatch(/matkalla/);
  });
});

describe("close copy", () => {
  it("says access will be disabled and does not say the account stays open", () => {
    expect(CLOSE_REQUEST_MESSAGE).toMatch(/kirjautuminen estetään/);
    expect(CLOSE_REQUEST_MESSAGE).not.toMatch(/ei suljeta/);
  });
});

describe("F54: the support page says where to write", () => {
  it("names the configured address and puts it in the copied-message toast", () => {
    expect(supportContactLine("tuki@example.fi")).toContain("tuki@example.fi");
    expect(reportCopiedToast("tuki@example.fi")).toBe("Viesti kopioitu. Liitä se sähköpostiin osoitteeseen tuki@example.fi.");
  });

  it("with no address says so plainly and never promises one", () => {
    const line = supportContactLine("");
    expect(line).toMatch(/ei ole vielä määritetty/);
    expect(line).toMatch(/Ilmoita ongelmasta/);
    expect(line).not.toMatch(/@/);
    expect(reportCopiedToast("")).toBe("Viesti kopioitu. Liitä se viestiin ja lähetä se sovelluksen ylläpitäjälle.");
  });
});
