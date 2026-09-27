"use client";

import { useState, useSyncExternalStore } from "react";
import { appLockMatches, readAppLock } from "@/lib/app-lock";
import { nextLockView, type LockView } from "@/lib/session-policy";
import { Button } from "@/components/ui";

let lockView: LockView = "open";
const viewListeners = new Set<() => void>();

function emitView(): void {
  for (const listener of viewListeners) listener();
}

function publishView(next: LockView): void {
  lockView = next;
  emitView();
}

function subscribeView(listener: () => void): () => void {
  viewListeners.add(listener);
  if (typeof document !== "undefined" && viewListeners.size === 1) {
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onVisibility);
  }
  return () => {
    viewListeners.delete(listener);
    if (viewListeners.size === 0 && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onVisibility);
    }
  };
}

function onVisibility(): void {
  const enabled = Boolean(readAppLock());
  if (document.visibilityState === "hidden") {
    publishView(nextLockView(enabled, "hide"));
    return;
  }
  if (lockView === "covered") publishView(nextLockView(enabled, "show"));
}

let primed = false;

function clientLockView(): LockView {
  if (!primed && typeof window !== "undefined") {
    primed = true;
    lockView = nextLockView(Boolean(readAppLock()), "show");
  }
  return lockView;
}

/**
 * Covers the books when a local code is set. The server session stays.
 * Face ID is not available in this web build; see app/docs/app-lock.md.
 */
export function AppLock({ children }: { children: React.ReactNode }) {
  const view = useSyncExternalStore(subscribeView, clientLockView, () => "open" as LockView);
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);

  if (view === "open") return <>{children}</>;

  async function unlock(event: React.FormEvent) {
    event.preventDefault();
    const record = readAppLock();
    if (!record) {
      publishView("open");
      return;
    }
    setChecking(true);
    setError("");
    const ok = await appLockMatches(record, pin);
    setChecking(false);
    if (!ok) {
      setError("Koodi ei täsmää.");
      return;
    }
    setPin("");
    publishView(nextLockView(true, "unlock"));
  }

  return (
    <div className="app-frame bg-cream">
      <form
        onSubmit={(event) => void unlock(event)}
        className="max-w-sm mx-auto mt-24 px-4 space-y-4"
      >
        <h1 className="text-2xl font-light text-charcoal text-center">LashKirja</h1>
        <p className="text-sm text-warm-gray text-center">
          Näyttö on lukittu tällä laitteella. Kirjanpito ei näy, ennen kuin koodi annetaan.
          Palvelimen istunto pysyy.
        </p>
        <label htmlFor="app-lock-pin" className="block text-sm font-medium text-charcoal">
          Lukituskoodi
        </label>
        <input
          id="app-lock-pin"
          inputMode="numeric"
          autoComplete="off"
          value={pin}
          onChange={(event) => setPin(event.target.value)}
          className="w-full min-h-12 px-4 rounded-xl border border-warm-gray-light bg-white text-charcoal"
        />
        {error && (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        )}
        <Button type="submit" busy={checking} busyLabel="Tarkistetaan…" className="w-full">
          Avaa
        </Button>
      </form>
    </div>
  );
}
