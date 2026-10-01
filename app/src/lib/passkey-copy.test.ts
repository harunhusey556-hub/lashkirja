import { describe, expect, it } from "vitest";
import { passkeyFailureMessage, passkeysRemovedNote } from "@/lib/passkey-copy";

describe("passkeysRemovedNote", () => {
  it("says nothing when no passkey was removed", () => {
    expect(passkeysRemovedNote(0)).toBe("");
    expect(passkeysRemovedNote(undefined)).toBe("");
  });

  it("tells the user passkeys were removed and how to get them back", () => {
    expect(passkeysRemovedNote(1)).toBe("Pääsyavain poistettiin. Luo uusi kohdassa Asetukset > Pääsyavaimet.");
    expect(passkeysRemovedNote(3)).toBe("3 pääsyavainta poistettiin. Luo uusi kohdassa Asetukset > Pääsyavaimet.");
  });
});

describe("wrong password before creating a passkey", () => {
  it("uses the server's message, with a Finnish fallback", () => {
    expect(passkeyFailureMessage("password", "create", "Nykyinen salasana on väärä.")).toBe("Nykyinen salasana on väärä.");
    expect(passkeyFailureMessage("password", "create")).toBe("Nykyinen salasana on väärä.");
  });
});
