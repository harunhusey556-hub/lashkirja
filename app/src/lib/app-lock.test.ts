import { describe, expect, it } from "vitest";
import {
  appLockStorageKey,
  clearAppLock,
  createAppLockRecord,
  pinBackoffMs,
  readAppLock,
  readBiometricUnlock,
  registerPinFailure,
  writeAppLock,
  writeBiometricUnlock,
  type LockStorage,
} from "./app-lock";

function memoryLockStorage(): LockStorage {
  const data = new Map<string, string>();
  return {
    get: (key) => data.get(key) ?? null,
    set: (key, value) => {
      data.set(key, value);
    },
    remove: (key) => {
      data.delete(key);
    },
    keys: () => [...data.keys()],
  };
}

describe("app lock scope and backoff", () => {
  it("keeps one user's code away from another account", async () => {
    const storage = memoryLockStorage();
    storage.set("lashkirja.app-lock.v1", JSON.stringify({ salt: "old", hash: "old" }));
    const record = await createAppLockRecord("1234");
    writeAppLock("user-a", record!, storage);
    expect(storage.get("lashkirja.app-lock.v1")).toBeNull();
    expect(readAppLock("user-b", storage)).toBeNull();
    expect(readAppLock("user-a", storage)?.hash).toBe(record!.hash);
    expect(appLockStorageKey("user-a")).not.toBe(appLockStorageKey("user-b"));
    writeBiometricUnlock("user-c", true, storage);
    expect(readBiometricUnlock("user-c", storage)).toBe(false);
    writeBiometricUnlock("user-a", true, storage);
    expect(readBiometricUnlock("user-a", storage)).toBe(true);
    expect(readBiometricUnlock("user-b", storage)).toBe(false);
    clearAppLock("user-a", storage);
    expect(readAppLock("user-a", storage)).toBeNull();
    expect(readBiometricUnlock("user-a", storage)).toBe(false);
  });

  it("waits longer after each wrong code, up to 30 seconds", () => {
    expect(pinBackoffMs(1)).toBe(1000);
    expect(pinBackoffMs(2)).toBe(2000);
    expect(pinBackoffMs(3)).toBe(4000);
    expect(pinBackoffMs(8)).toBe(30_000);
    const first = registerPinFailure(null, 1_000);
    expect(first).toEqual({ count: 1, lockedUntil: 2_000 });
    const second = registerPinFailure(first, 2_000);
    expect(second.count).toBe(2);
    expect(second.lockedUntil - 2_000).toBe(2000);
  });
});
