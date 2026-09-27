"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import {
  appLockMatches,
  clearAppLock,
  deviceHasAnyAppLock,
  readAppLock,
  readPinAttempts,
  registerPinFailure,
  writePinAttempts,
} from "@/lib/app-lock";
import { nextLockView, type LockView } from "@/lib/session-policy";
import { Button } from "@/components/ui";
import { apiFetch, leaveAfterSignOut, readJson } from "@/components/clientFetch";

let lockView: LockView = "open";
let lockUserId: string | null = null;
const viewListeners = new Set<() => void>();

function emitView(): void {
  for (const listener of viewListeners) listener();
}

function publishView(next: LockView): void {
  lockView = next;
  emitView();
}

function currentLockEnabled(): boolean {
  return Boolean(readAppLock(lockUserId));
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
  const enabled = currentLockEnabled();
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
    lockView = deviceHasAnyAppLock() ? "locked" : "open";
  }
  return lockView;
}

/**
 * Covers the books when a local code is set for this user. The server session stays.
 * Face ID is not available in this web build; see app/docs/app-lock.md.
 */
export function AppLock({ children }: { children: React.ReactNode }) {
  const view = useSyncExternalStore(subscribeView, clientLockView, () => "open" as LockView);
  const [userId, setUserId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const [confirmForget, setConfirmForget] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    void apiFetch("/api/auth/me")
      .then((response) => readJson<{ user: { userId?: string } | null }>(response, ""))
      .then((data) => {
        if (cancelled) return;
        const nextId = data.user?.userId ?? null;
        lockUserId = nextId;
        setUserId(nextId);
        setReady(true);
        if (!readAppLock(nextId)) publishView("open");
        else if (lockView !== "covered") publishView("locked");
      })
      .catch(() => {
        if (cancelled) return;
        lockUserId = null;
        setReady(true);
        publishView("open");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const attempts = userId ? readPinAttempts(userId) : null;
  const waitMs = attempts && attempts.lockedUntil > now ? attempts.lockedUntil - now : 0;

  useEffect(() => {
    if (waitMs <= 0) return;
    const handle = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(handle);
  }, [waitMs]);

  if (view === "open") return <>{children}</>;
  if (!ready) {
    return (
      <div className="app-frame bg-cream">
        <p className="max-w-sm mx-auto mt-24 px-4 text-sm text-warm-gray text-center">Tarkistetaan lukitusta…</p>
      </div>
    );
  }

  async function unlock(event: React.FormEvent) {
    event.preventDefault();
    if (!userId || waitMs > 0) return;
    const record = readAppLock(userId);
    if (!record) {
      publishView("open");
      return;
    }
    setChecking(true);
    setError("");
    const ok = await appLockMatches(record, pin);
    setChecking(false);
    if (!ok) {
      const next = registerPinFailure(readPinAttempts(userId), Date.now());
      writePinAttempts(userId, next);
      setNow(Date.now());
      setError(next.count >= 5 ? "Liian monta yritystä. Jos koodi on unohtunut, kirjaudu ulos." : "Koodi ei täsmää.");
      return;
    }
    writePinAttempts(userId, null);
    setPin("");
    publishView(nextLockView(true, "unlock"));
  }

  async function forgetPin() {
    clearAppLock(userId);
    publishView("open");
    const left = await leaveAfterSignOut();
    if (!left) setError("Uloskirjautuminen epäonnistui. Istunto voi olla yhä voimassa.");
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
          type="password"
          inputMode="numeric"
          autoComplete="off"
          value={pin}
          onChange={(event) => setPin(event.target.value)}
          className="w-full min-h-12 px-4 rounded-xl border border-warm-gray-light bg-white text-charcoal"
        />
        {waitMs > 0 && (
          <p className="text-sm text-warm-gray" role="status">
            Odota {Math.ceil(waitMs / 1000)} sekuntia.
          </p>
        )}
        {error && (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        )}
        <Button type="submit" busy={checking} busyLabel="Tarkistetaan…" className="w-full" disabled={waitMs > 0}>
          Avaa
        </Button>
        {confirmForget ? (
          <div className="space-y-2">
            <p className="text-sm text-charcoal">Lukitus poistetaan ja sinut kirjataan ulos. Jatka?</p>
            <Button type="button" variant="secondary" className="w-full" onClick={() => void forgetPin()}>
              Kirjaudu ulos
            </Button>
            <button type="button" className="block min-h-11 w-full text-sm text-warm-gray" onClick={() => setConfirmForget(false)}>
              Peruuta
            </button>
          </div>
        ) : (
          <button type="button" className="block min-h-11 w-full text-sm text-accent-dark" onClick={() => setConfirmForget(true)}>
            Unohdin koodin
          </button>
        )}
      </form>
    </div>
  );
}
