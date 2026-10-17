import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import { DEVICE_SIGNATURE_SKEW_S } from "@/lib/session-limits";

/**
 * A trusted device holds a P-256 key (Secure Enclave on iOS) and signs every
 * token refresh, so a stolen bearer token alone cannot be refreshed. The
 * stored deviceKey is base64 of the 65-byte uncompressed X9.63 point.
 */

const KEY_BASE64 = /^[A-Za-z0-9+/]{87}=$/;

function publicKeyFrom(deviceKey: string): KeyObject | null {
  if (!KEY_BASE64.test(deviceKey)) return null;
  const point = Buffer.from(deviceKey, "base64");
  if (point.length !== 65 || point[0] !== 0x04) return null;
  try {
    return createPublicKey({
      key: { kty: "EC", crv: "P-256", x: point.subarray(1, 33).toString("base64url"), y: point.subarray(33).toString("base64url") },
      format: "jwk",
    });
  } catch {
    // Not a point on the curve.
    return null;
  }
}

/** The key to store for a sign-in body field, or null (sign-in goes on, the session stays unbound). */
export function acceptDeviceKey(value: unknown, where: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && publicKeyFrom(value)) return value;
  console.warn(`[auth] ignoring invalid deviceKey at ${where}`);
  return null;
}

export function refreshMessage(time: string, bearerToken: string): string {
  return `lk-refresh-v1\n${time}\n${createHash("sha256").update(bearerToken).digest("hex")}`;
}

/** True when `signature` (base64 DER ECDSA P-256/SHA-256) covers this refresh and `time` is fresh. */
export function verifyRefreshSignature(
  deviceKey: string,
  bearerToken: string,
  time: string | null,
  signature: string | null,
  nowMs = Date.now()
): boolean {
  if (!time || !signature || !/^\d{1,12}$/.test(time)) return false;
  if (Math.abs(Math.floor(nowMs / 1000) - Number(time)) > DEVICE_SIGNATURE_SKEW_S) return false;
  const key = publicKeyFrom(deviceKey);
  if (!key) return false;
  try {
    return verify(
      "sha256",
      Buffer.from(refreshMessage(time, bearerToken), "utf8"),
      { key, dsaEncoding: "der" },
      Buffer.from(signature, "base64")
    );
  } catch {
    // A malformed signature is a failed one.
    return false;
  }
}
