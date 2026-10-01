"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import {
  appLockMatches,
  clearAppLock,
  deviceHasAnyAppLock,
  readAppLock,
  readBiometricUnlock,
  readPinAttempts,
  registerPinFailure,
  writePinAttempts,
} from "@/lib/app-lock";
import {
  biometricUnlockLabel,
  readDeviceBiometry,
  unlockWithBiometry,
  type BiometryStatus,
} from "@/lib/biometry";
import { nextLockView, type LockView } from "@/lib/session-policy";
import { Button } from "@/components/ui";
import { PasswordField } from "@/components/ds/PasswordField";
import { AppMark } from "@/components/AppMark";
import { leaveAfterSignOut } from "@/components/clientFetch";
import { useSession } from "@/components/SessionProvider";
import { tintedButtonClass } from "@/components/control-styles";

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
 * Face ID or Touch ID can dismiss the cover when this user opted in and the
 * native plugin is in the IPA. Otherwise the PIN remains.
 */
export function AppLock({ children }: { children: React.ReactNode }) {
  const view = useSyncExternalStore(subscribeView, clientLockView, () => "open" as LockView);
  const { status: sessionStatus, user } = useSession();
  const userId = user?.userId ?? null;
  // "unknown" is the only status still waiting on the session source (the
  // web target never sees it; mobile does, briefly, until bootMobile()/`/me`
  // resolve). Both "signed-in" and "signed-out" are a real verdict.
  const ready = sessionStatus !== "unknown";
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const [confirmForget, setConfirmForget] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [bio, setBio] = useState<BiometryStatus | null>(null);
  const [bioNote, setBioNote] = useState("");

  useEffect(() => {
    if (!ready) return;
    lockUserId = userId;
    if (!readAppLock(userId)) publishView("open");
    else if (lockView !== "covered") publishView("locked");
  }, [ready, userId]);

  const attempts = userId ? readPinAttempts(userId) : null;
  const waitMs = attempts && attempts.lockedUntil > now ? attempts.lockedUntil - now : 0;

  useEffect(() => {
    if (waitMs <= 0) return;
    const handle = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(handle);
  }, [waitMs]);

  useEffect(() => {
    if (view !== "locked" || !ready || !userId || !readBiometricUnlock(userId)) return;
    let cancelled = false;
    void readDeviceBiometry()
      .then(async (status) => {
        if (cancelled) return;
        setBio(status);
        if (!status.available) {
          setBioNote("Biometria ei ole käytettävissä. Käytä koodia.");
          return;
        }
        const result = await unlockWithBiometry();
        if (cancelled || result === "ok") {
          if (!cancelled && result === "ok") publishView(nextLockView(true, "unlock"));
          return;
        }
        setBioNote(result === "unavailable" ? "Biometria ei ole käytettävissä. Käytä koodia." : "Biometria ei onnistunut. Käytä koodia.");
      })
      .catch(() => {
        if (!cancelled) setBioNote("Biometria ei ole käytettävissä. Käytä koodia.");
      });
    return () => {
      cancelled = true;
    };
  }, [view, ready, userId]);

  async function retryBiometry() {
    setBioNote("");
    const result = await unlockWithBiometry();
    if (result === "ok") {
      publishView(nextLockView(true, "unlock"));
      return;
    }
    setBioNote(result === "unavailable" ? "Biometria ei ole käytettävissä. Käytä koodia." : "Biometria ei onnistunut. Käytä koodia.");
  }

  if (view === "open") return <>{children}</>;
  if (!ready) {
    return (
      // No "Tarkistetaan…" line: the check takes a frame or two, so the canvas stands in silently.
      <div className="app-frame bg-canvas" aria-busy="true" />
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
      setError(next.count >= 5 ? "Liian monta yritystä. Jos koodi on unohtunut, kirjaa ulos." : "Koodi ei täsmää.");
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
    <div className="app-frame bg-canvas">
      <form
        onSubmit={(event) => void unlock(event)}
        className="mx-auto mt-20 w-full max-w-sm space-y-4 px-4"
      >
        <div className="flex flex-col items-center gap-3 pb-2">
          <AppMark size={64} />
          <h1 className="text-2xl font-bold tracking-[-0.02em] text-ink">LashKirja</h1>
          <p className="text-center text-body leading-relaxed text-ink-2">
            Näyttö on lukittu tällä laitteella. Kirjanpito ei näy, ennen kuin koodi tai biometria avaa sen.
            Palvelimen istunto pysyy.
          </p>
        </div>
        {bio?.available && (
          <Button type="button" variant="secondary" className="w-full" onClick={() => void retryBiometry()}>
            {biometricUnlockLabel(bio.kind)}
          </Button>
        )}
        {bioNote && (
          <p className="text-center text-sm text-ink-2" role="status">
            {bioNote}
          </p>
        )}
        <PasswordField
          id="app-lock-pin"
          label="Lukituskoodi"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={8}
          autoComplete="off"
          enterKeyHint="go"
          showLabel="Näytä koodi"
          hideLabel="Piilota koodi"
          value={pin}
          onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 8))}
          // Symmetric side padding keeps the centred dots centred beside the eye.
          style={{ paddingLeft: 48 }}
          inputClassName="text-center tracking-[0.3em]"
        />
        {waitMs > 0 && (
          <p className="text-sm text-ink-2" role="status">
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
            <p className="text-sm text-ink">Lukitus poistetaan ja sinut kirjataan ulos. Jatka?</p>
            <Button type="button" variant="secondary" className="w-full" onClick={() => void forgetPin()}>
              Kirjaa ulos
            </Button>
            <button type="button" className={tintedButtonClass("neutral", "w-full")} onClick={() => setConfirmForget(false)}>
              Peruuta
            </button>
          </div>
        ) : (
          <button type="button" className={tintedButtonClass("accent", "w-full")} onClick={() => setConfirmForget(true)}>
            Unohdin koodin
          </button>
        )}
      </form>
    </div>
  );
}
