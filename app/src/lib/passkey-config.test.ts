import { describe, expect, it } from "vitest";
import { appleAppSiteAssociation, passkeyConfig, passkeyStatus } from "./passkey-config";
import { classifyCeremonyError, passkeyFailureMessage } from "./passkey-copy";

const env = (values: Record<string, string>) => values as unknown as NodeJS.ProcessEnv;

describe("passkeyConfig", () => {
  it("is null without a valid RP ID", () => {
    expect(passkeyConfig(env({}))).toBeNull();
    expect(passkeyConfig(env({ WEBAUTHN_RP_ID: "https://host.example" }))).toBeNull();
    expect(passkeyConfig(env({ WEBAUTHN_RP_ID: "bad host" }))).toBeNull();
  });

  it("defaults the origin to https://<rpId> and lowercases the host", () => {
    expect(passkeyConfig(env({ WEBAUTHN_RP_ID: "Desktop-1.Tail.ts.net" }))).toEqual({
      rpId: "desktop-1.tail.ts.net",
      rpName: "LashKirja",
      origins: ["https://desktop-1.tail.ts.net"],
      appleTeamId: null,
    });
  });

  it("accepts https origins and http only on localhost", () => {
    const config = passkeyConfig(
      env({
        WEBAUTHN_RP_ID: "localhost",
        WEBAUTHN_ORIGINS: "http://localhost:3200, http://evil.example, https://a.example/path, nonsense",
      })
    );
    expect(config?.origins).toEqual(["http://localhost:3200", "https://a.example"]);
  });

  it("native needs a well-formed team id; AASA lists the team-prefixed bundle id", () => {
    expect(passkeyStatus(env({ WEBAUTHN_RP_ID: "a.example", APPLE_TEAM_ID: "short" }))).toEqual({ web: true, native: false });
    expect(passkeyStatus(env({ WEBAUTHN_RP_ID: "a.example", APPLE_TEAM_ID: "abcde12345" }))).toEqual({ web: true, native: true });
    expect(appleAppSiteAssociation(env({}))).toBeNull();
    expect(appleAppSiteAssociation(env({ APPLE_TEAM_ID: "ABCDE12345" }))).toEqual({
      webcredentials: { apps: ["ABCDE12345.fi.tiyouba.lashkirja"] },
    });
  });
});

describe("passkey ceremony errors", () => {
  it("classifies native codes, browser codes and DOMException names", () => {
    expect(classifyCeremonyError({ code: "CANCELLED" })).toBe("cancelled");
    expect(classifyCeremonyError({ name: "NotAllowedError" })).toBe("cancelled");
    expect(classifyCeremonyError({ code: "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED" })).toBe("exists");
    expect(classifyCeremonyError({ code: "NOT_ASSOCIATED" })).toBe("not-configured");
    expect(classifyCeremonyError({ code: "UNIMPLEMENTED" })).toBe("unsupported");
    expect(classifyCeremonyError(new Error("x"))).toBe("failed");
    expect(classifyCeremonyError(undefined)).toBe("failed");
  });

  it("says nothing on cancel, and Finnish text otherwise", () => {
    expect(passkeyFailureMessage("cancelled", "sign-in")).toBeNull();
    expect(passkeyFailureMessage("unsupported", "sign-in")).toMatch(/ei tue pääsyavaimia/);
    expect(passkeyFailureMessage("rate", "sign-in", "Palvelimen viesti")).toBe("Palvelimen viesti");
    expect(passkeyFailureMessage("failed", "create")).toMatch(/luonti epäonnistui/);
  });
});
