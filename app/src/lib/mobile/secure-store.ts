/**
 * Where the mobile auth token (and, from Task 7, the persistent cache's own
 * encryption key) lives on disk.
 *
 * Native app (`Capacitor.isNativePlatform()` true): the iOS Keychain,
 * through @aparajita/capacitor-secure-storage. The default accessibility
 * class is raised once, lazily, to "after first unlock, this device only" --
 * the item never migrates to a new device via an encrypted backup, and it
 * survives a restart but not a factory reset or the app being deleted.
 *
 * Not native, but the emulation harness (hostname 127.0.0.1 or localhost --
 * the served static export at :3210, scripts/mobile/serve-export.ts, or the
 * dev server itself): localStorage under a distinct "lashkirja.emu." prefix,
 * so relaunching the served export behaves like relaunching the real app
 * for local testing, without ever touching the real device Keychain.
 *
 * Anything else (the desktop web app, wherever it is actually served from):
 * memory only, for the tab's lifetime -- the same rule page-cache.ts already
 * applies to bookkeeping data ("no business surviving in storage after the
 * tab is closed").
 */
import { Capacitor } from "@capacitor/core";

export interface SecureStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export const SECURE_KEYS = {
  auth: "lashkirja.auth.v1",
  cacheKey: "lashkirja.cachekey.v1",
  pendingRevoke: "lashkirja.pending-revoke.v1",
} as const;

const EMULATION_PREFIX = "lashkirja.emu.";

function isNativePlatform(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

function isEmulationHost(): boolean {
  if (typeof window === "undefined") return false;
  const hostname = window.location?.hostname;
  return hostname === "127.0.0.1" || hostname === "localhost";
}

let keychainAccessConfigured: Promise<void> | null = null;

/**
 * The plugin is imported dynamically so it is never loaded (and never asks
 * for anything native) on the web build or in the emulation/memory paths,
 * where it would just be dead weight -- and never loaded at all in the unit
 * test process, since isNativePlatform() there is always false.
 */
function nativeStore(): SecureStore {
  return {
    async get(key) {
      const { SecureStorage } = await import("@aparajita/capacitor-secure-storage");
      try {
        return await SecureStorage.getItem(key);
      } catch {
        return null;
      }
    },
    async set(key, value) {
      const { SecureStorage, KeychainAccess } = await import("@aparajita/capacitor-secure-storage");
      if (!keychainAccessConfigured) {
        keychainAccessConfigured = SecureStorage.setDefaultKeychainAccess(
          KeychainAccess.afterFirstUnlockThisDeviceOnly
        ).catch(() => undefined);
      }
      await keychainAccessConfigured;
      await SecureStorage.setItem(key, value);
    },
    async remove(key) {
      const { SecureStorage } = await import("@aparajita/capacitor-secure-storage");
      try {
        await SecureStorage.removeItem(key);
      } catch {
        // Already absent, or the OS refused -- either way nothing is left
        // to remove, and a logout must never throw.
      }
    },
  };
}

function emulationStore(): SecureStore {
  return {
    async get(key) {
      try {
        return window.localStorage.getItem(EMULATION_PREFIX + key);
      } catch {
        return null;
      }
    },
    async set(key, value) {
      try {
        window.localStorage.setItem(EMULATION_PREFIX + key, value);
      } catch {
        // Storage full/unavailable: the in-memory copy for this session
        // still works, it just will not survive a reload.
      }
    },
    async remove(key) {
      try {
        window.localStorage.removeItem(EMULATION_PREFIX + key);
      } catch {
        // ignore
      }
    },
  };
}

function memoryStore(): SecureStore {
  const memory = new Map<string, string>();
  return {
    async get(key) {
      return memory.get(key) ?? null;
    },
    async set(key, value) {
      memory.set(key, value);
    },
    async remove(key) {
      memory.delete(key);
    },
  };
}

let cached: SecureStore | null = null;

/** Memoized: the host (native app / emulation harness / plain browser tab)
 * cannot change during one run. */
export function secureStore(): SecureStore {
  if (!cached) {
    cached = isNativePlatform() ? nativeStore() : isEmulationHost() ? emulationStore() : memoryStore();
  }
  return cached;
}
