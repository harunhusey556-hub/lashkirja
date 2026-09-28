import { describe, expect, it } from "vitest";
import { decryptJson, encryptJson, generateCacheKeyBase64, importCacheKey, isCryptoAvailable } from "./crypto-box";

describe("isCryptoAvailable", () => {
  it("is true in the Node test process (globalThis.crypto.subtle)", () => {
    expect(isCryptoAvailable()).toBe(true);
  });
});

describe("generateCacheKeyBase64 / importCacheKey", () => {
  it("produces a usable AES-GCM key, and two calls never collide", async () => {
    const a = generateCacheKeyBase64();
    const b = generateCacheKeyBase64();
    expect(a).not.toBe(b);
    const key = await importCacheKey(a);
    expect(key.algorithm.name).toBe("AES-GCM");
    expect(key.extractable).toBe(false);
  });
});

describe("encryptJson / decryptJson", () => {
  it("round-trips an arbitrary JSON value", async () => {
    const key = await importCacheKey(generateCacheKeyBase64());
    const value = { receipts: [{ id: "r1", amountCents: 1234 }], fetchedAt: 1700000000000 };

    const box = await encryptJson(key, value);
    expect(box.iv.byteLength).toBe(12);

    const decrypted = await decryptJson<typeof value>(key, box);
    expect(decrypted).toEqual(value);
  });

  it("two encryptions of the same value use different IVs and ciphertexts", async () => {
    const key = await importCacheKey(generateCacheKeyBase64());
    const boxA = await encryptJson(key, { a: 1 });
    const boxB = await encryptJson(key, { a: 1 });
    expect(Buffer.from(boxA.iv)).not.toEqual(Buffer.from(boxB.iv));
    expect(Buffer.from(boxA.data)).not.toEqual(Buffer.from(boxB.data));
  });

  it("rejects a ciphertext tampered after encryption", async () => {
    const key = await importCacheKey(generateCacheKeyBase64());
    const box = await encryptJson(key, { secret: "kirjanpito" });
    const tampered = new Uint8Array(box.data.slice(0));
    tampered[0] = tampered[0] ^ 0xff;

    await expect(decryptJson(key, { iv: box.iv, data: tampered.buffer })).rejects.toBeTruthy();
  });

  it("rejects decryption with the wrong key", async () => {
    const key = await importCacheKey(generateCacheKeyBase64());
    const otherKey = await importCacheKey(generateCacheKeyBase64());
    const box = await encryptJson(key, { secret: "kirjanpito" });

    await expect(decryptJson(otherKey, box)).rejects.toBeTruthy();
  });

  it("rejects decryption with the wrong IV", async () => {
    const key = await importCacheKey(generateCacheKeyBase64());
    const box = await encryptJson(key, { secret: "kirjanpito" });
    const wrongIv = new Uint8Array(box.iv);
    wrongIv[0] = wrongIv[0] ^ 0xff;

    await expect(decryptJson(key, { iv: wrongIv, data: box.data })).rejects.toBeTruthy();
  });
});
