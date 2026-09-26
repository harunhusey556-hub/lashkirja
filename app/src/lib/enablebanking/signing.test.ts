import { createVerify, generateKeyPairSync } from "crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  authorizationMatches,
  clearEnableBankingConfigCache,
  decodeJwtPart,
  decodeKeyMaterial,
  signEnableBankingJwt,
} from "./signing";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();

afterEach(() => {
  clearEnableBankingConfigCache();
});

describe("signEnableBankingJwt", () => {
  it("signs an RS256 JWT with the application id and Enable Banking claims", () => {
    const now = 1_700_000_000;
    const token = signEnableBankingJwt(privatePem, "app-123", now);
    const header = decodeJwtPart<{ typ: string; alg: string; kid: string }>(token, 0);
    const payload = decodeJwtPart<{ iss: string; aud: string; iat: number; exp: number }>(token, 1);

    expect(header).toEqual({ typ: "JWT", alg: "RS256", kid: "app-123" });
    expect(payload).toEqual({
      iss: "enablebanking.com",
      aud: "api.enablebanking.com",
      iat: now,
      exp: now + 3600,
    });
    expect(token).not.toContain("PRIVATE KEY");

    const [unsigned, signature] = [
      token.split(".").slice(0, 2).join("."),
      token.split(".")[2],
    ];
    const verifier = createVerify("RSA-SHA256");
    verifier.update(unsigned);
    verifier.end();
    expect(verifier.verify(publicPem, Buffer.from(signature, "base64url"))).toBe(true);
  });
});

describe("decodeKeyMaterial", () => {
  it("accepts a PEM string and a base64 PEM", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n";
    expect(decodeKeyMaterial(pem)).toBe(pem);
    expect(decodeKeyMaterial(Buffer.from(pem).toString("base64"))).toBe(pem);
  });

  it("rejects material that is not a PEM key", () => {
    expect(() => decodeKeyMaterial(Buffer.from("not a key").toString("base64"))).toThrow(
      /PEM/
    );
  });
});

describe("authorizationMatches", () => {
  it("requires the exact bearer secret", () => {
    expect(authorizationMatches("Bearer cron-secret", "cron-secret")).toBe(true);
    expect(authorizationMatches("Bearer wrong", "cron-secret")).toBe(false);
    expect(authorizationMatches(null, "cron-secret")).toBe(false);
    expect(authorizationMatches("Bearer cron-secret", "")).toBe(false);
  });
});
