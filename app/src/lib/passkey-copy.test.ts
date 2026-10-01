import { describe, expect, it } from "vitest";
import { passkeyFailureMessage } from "@/lib/passkey-copy";

describe("wrong password before creating a passkey", () => {
  it("uses the server's message, with a Finnish fallback", () => {
    expect(passkeyFailureMessage("password", "create", "Nykyinen salasana on väärä.")).toBe("Nykyinen salasana on väärä.");
    expect(passkeyFailureMessage("password", "create")).toBe("Nykyinen salasana on väärä.");
  });
});
