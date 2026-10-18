import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acceptDeviceKey, checkRefreshSignature, refreshMessage, verifyRefreshSignature } from "./device-key";

function newDevice() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const key = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x as string, "base64url"),
    Buffer.from(jwk.y as string, "base64url"),
  ]).toString("base64");
  const signFor = (token: string, time: string) =>
    sign("sha256", Buffer.from(refreshMessage(time, token), "utf8"), { key: privateKey, dsaEncoding: "der" }).toString("base64");
  return { key, signFor };
}

const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);
const nowSeconds = String(NOW / 1000);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("refreshMessage", () => {
  it("is the version tag, the time and the lowercase hex sha256 of the token", () => {
    const hash = createHash("sha256").update("tok.en").digest("hex");
    expect(refreshMessage("1760702400", "tok.en")).toBe(`lk-refresh-v1\n1760702400\n${hash}`);
    expect(hash).toBe(hash.toLowerCase());
  });
});

describe("acceptDeviceKey", () => {
  it("returns a valid key unchanged and null for absent", () => {
    const { key } = newDevice();
    expect(acceptDeviceKey(key, "test")).toBe(key);
    expect(acceptDeviceKey(undefined, "test")).toBeNull();
  });

  it("ignores anything else with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const compressed = Buffer.concat([Buffer.from([2]), Buffer.alloc(32, 3)]).toString("base64");
    const bad = ["", "AAAA", compressed, 7, {}, "x".repeat(88)];
    for (const value of bad) expect(acceptDeviceKey(value, "test")).toBeNull();
    expect(warn).toHaveBeenCalledTimes(bad.length);
  });
});

describe("verifyRefreshSignature", () => {
  it("accepts a signature over the exact token string within the skew", () => {
    const { key, signFor } = newDevice();
    expect(verifyRefreshSignature(key, "tok", nowSeconds, signFor("tok", nowSeconds), NOW)).toBe(true);
    const early = String(NOW / 1000 - 300);
    expect(verifyRefreshSignature(key, "tok", early, signFor("tok", early), NOW)).toBe(true);
  });

  it("refuses a missing, wrong-token, wrong-key or garbage signature", () => {
    const { key, signFor } = newDevice();
    expect(verifyRefreshSignature(key, "tok", nowSeconds, null, NOW)).toBe(false);
    expect(verifyRefreshSignature(key, "tok", null, signFor("tok", nowSeconds), NOW)).toBe(false);
    expect(verifyRefreshSignature(key, "tok2", nowSeconds, signFor("tok", nowSeconds), NOW)).toBe(false);
    expect(verifyRefreshSignature(key, "tok", nowSeconds, newDevice().signFor("tok", nowSeconds), NOW)).toBe(false);
    expect(verifyRefreshSignature(key, "tok", nowSeconds, "%%%", NOW)).toBe(false);
  });

  it("says skew only for the device's own signature on a clock more than 300 s off", () => {
    const { key, signFor } = newDevice();
    for (const time of [String(NOW / 1000 - 301), String(NOW / 1000 + 3 * 3600)]) {
      expect(checkRefreshSignature(key, "tok", time, signFor("tok", time), NOW)).toBe("skew");
      expect(checkRefreshSignature(key, "tok", time, newDevice().signFor("tok", time), NOW)).toBe("bad");
      expect(checkRefreshSignature(key, "tok2", time, signFor("tok", time), NOW)).toBe("bad");
    }
    expect(checkRefreshSignature(key, "tok", nowSeconds, signFor("tok", nowSeconds), NOW)).toBe("ok");
    expect(checkRefreshSignature(key, "tok", "1e9", signFor("tok", "1e9"), NOW)).toBe("bad");
  });

  it("refuses a time 301 seconds away or not a plain number", () => {
    const { key, signFor } = newDevice();
    for (const time of [String(NOW / 1000 - 301), String(NOW / 1000 + 301), "1e9", "-5", "abc"]) {
      expect(verifyRefreshSignature(key, "tok", time, signFor("tok", time), NOW)).toBe(false);
    }
  });
});
