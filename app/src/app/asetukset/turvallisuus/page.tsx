"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { apiFetch, errorMessage, leaveAfterSignOut, readJson } from "@/components/clientFetch";
import { Button, controlClass } from "@/components/ui";
import {
  appLockMatches,
  clearAppLock,
  createAppLockRecord,
  readAppLock,
  readBiometricUnlock,
  subscribeAppLock,
  writeAppLock,
  writeBiometricUnlock,
} from "@/lib/app-lock";
import {
  biometricEnableLabel,
  biometricUnavailableCopy,
  readDeviceBiometry,
  unlockWithBiometry,
  type BiometryStatus,
} from "@/lib/biometry";

interface SessionRow {
  id: string;
  label: string;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}

export default function TurvallisuusPage() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordMsg, setPasswordMsg] = useState("");
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [sessionError, setSessionError] = useState("");
  const [lockPin, setLockPin] = useState("");
  const [lockMsg, setLockMsg] = useState("");
  const [lockUserId, setLockUserId] = useState<string | null>(null);
  const hasLock = useSyncExternalStore(
    subscribeAppLock,
    () => Boolean(lockUserId && readAppLock(lockUserId)),
    () => false
  );
  const bioOn = useSyncExternalStore(
    subscribeAppLock,
    () => Boolean(lockUserId && readBiometricUnlock(lockUserId)),
    () => false
  );
  const [bio, setBio] = useState<BiometryStatus>({ available: false, kind: "none", host: "web" });

  useEffect(() => {
    let cancelled = false;
    void apiFetch("/api/auth/me")
      .then((response) => readJson<{ user: { userId?: string } | null }>(response, ""))
      .then((data) => {
        if (!cancelled) setLockUserId(data.user?.userId ?? null);
      })
      .catch(() => {
        if (!cancelled) setLockUserId(null);
      });
    void apiFetch("/api/auth/sessions")
      .then((response) => readJson<{ sessions: SessionRow[] }>(response, "Istuntoja ei saatu ladattua"))
      .then((data) => {
        if (!cancelled) setSessions(data.sessions);
      })
      .catch((error: unknown) => {
        if (!cancelled) setSessionError(errorMessage(error, "Istuntoja ei saatu ladattua"));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void readDeviceBiometry().then((status) => {
      if (!cancelled) setBio(status);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function changePassword(event: React.FormEvent) {
    event.preventDefault();
    setPasswordBusy(true);
    setPasswordMsg("");
    try {
      const response = await apiFetch("/api/auth/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      await readJson(response, "Salasanan vaihto epäonnistui");
      setCurrentPassword("");
      setNewPassword("");
      setPasswordMsg("Salasana vaihdettu. Muut laitteet kirjattiin ulos.");
    } catch (error: unknown) {
      setPasswordMsg(errorMessage(error, "Salasanan vaihto epäonnistui"));
    } finally {
      setPasswordBusy(false);
    }
  }

  async function revoke(body: { scope?: "others" | "all"; id?: string }) {
    setSessionError("");
    try {
      const response = await apiFetch("/api/auth/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await readJson<{ signedOut: boolean }>(response, "Istunnon sulkeminen epäonnistui");
      if (data.signedOut) {
        const left = await leaveAfterSignOut();
        if (!left) setSessionError("Uloskirjautuminen epäonnistui. Istunto voi olla yhä voimassa.");
        return;
      }
      setSessions((current) =>
        body.id ? current.filter((row) => row.id !== body.id) : current.filter((row) => row.current)
      );
    } catch (error: unknown) {
      setSessionError(errorMessage(error, "Istunnon sulkeminen epäonnistui"));
    }
  }

  async function saveLock(event: React.FormEvent) {
    event.preventDefault();
    if (!lockUserId) {
      setLockMsg("Kirjaudu sisään, ennen kuin otat lukituksen käyttöön.");
      return;
    }
    const record = await createAppLockRecord(lockPin);
    if (!record) {
      setLockMsg("Koodissa on 4–8 numeroa.");
      return;
    }
    writeAppLock(lockUserId, record);
    setLockPin("");
    setLockMsg(
      bio.available
        ? "Lukitus on päällä tällä laitteella. Voit ottaa biometrisen avauksen käyttöön alta. Se ei kirjaa sinua ulos palvelimelta."
        : "Lukitus on päällä tällä laitteella. Se ei kirjaa sinua ulos palvelimelta."
    );
  }

  async function enableBiometry() {
    if (!lockUserId || !hasLock) return;
    const result = await unlockWithBiometry();
    if (result !== "ok") {
      setLockMsg("Biometria ei vahvistunut. Koodi jää käyttöön.");
      return;
    }
    writeBiometricUnlock(lockUserId, true);
    setLockMsg("Biometrinen avaus on päällä tällä laitteella. Se ei korvaa palvelimen istuntoa.");
  }

  function disableBiometry() {
    if (!lockUserId) return;
    writeBiometricUnlock(lockUserId, false);
    setLockMsg("Biometrinen avaus poistettu. Koodi jää käyttöön.");
  }

  async function removeLock(event: React.FormEvent) {
    event.preventDefault();
    const record = readAppLock(lockUserId);
    if (!record || !lockUserId) return;
    const ok = await appLockMatches(record, lockPin);
    if (!ok) {
      setLockMsg("Koodi ei täsmää.");
      return;
    }
    clearAppLock(lockUserId);
    setLockPin("");
    setLockMsg("Lukitus poistettu tältä laitteelta.");
  }

  return (
    <div className="space-y-6">
      <form onSubmit={(event) => void changePassword(event)} className="bg-white rounded-2xl p-6 shadow-sm space-y-4">
        <h2 className="text-sm font-medium text-charcoal">Vaihda salasana</h2>
        <p className="text-sm text-warm-gray">
          Nykyinen salasana vaaditaan. Uudessa on vähintään 10 merkkiä. Muut kirjautuneet laitteet suljetaan.
        </p>
        <label htmlFor="currentPassword" className="block text-sm font-medium text-charcoal">
          Nykyinen salasana
        </label>
        <input
          id="currentPassword"
          type="password"
          autoComplete="current-password"
          required
          value={currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)}
          className={`${controlClass} min-h-12`}
        />
        <label htmlFor="newPassword" className="block text-sm font-medium text-charcoal">
          Uusi salasana
        </label>
        <input
          id="newPassword"
          type="password"
          autoComplete="new-password"
          required
          minLength={10}
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
          className={`${controlClass} min-h-12`}
        />
        {passwordMsg && (
          <p className="text-sm text-warm-gray" role="status">
            {passwordMsg}
          </p>
        )}
        <Button type="submit" busy={passwordBusy} busyLabel="Vaihdetaan…" className="ml-auto">
          Vaihda salasana
        </Button>
      </form>

      <section className="bg-white rounded-2xl p-6 shadow-sm space-y-3">
        <h2 className="text-sm font-medium text-charcoal">Laitteet</h2>
        <p className="text-sm text-warm-gray">
          Lista näyttää kirjautumiset, joissa istunto on tallennettu. Vanha selain ilman tunnistetta pysyy, kunnes kirjaudut ulos.
        </p>
        {sessionError && (
          <p className="text-sm text-danger" role="alert">
            {sessionError}
          </p>
        )}
        <ul className="divide-y divide-warm-gray-light/30">
          {sessions.map((row) => (
            <li key={row.id} className="py-3 flex items-center gap-3">
              <span className="flex-1 min-w-0">
                <span className="block text-sm text-charcoal">{row.label}</span>
                <span className="block text-xs text-warm-gray">
                  {row.current ? "Tämä laite" : "Muu laite"}
                </span>
              </span>
              {!row.current && (
                <button
                  type="button"
                  className="text-sm text-danger min-h-11 px-2"
                  onClick={() => void revoke({ id: row.id })}
                >
                  Sulje
                </button>
              )}
            </li>
          ))}
        </ul>
        <Button type="button" variant="secondary" onClick={() => void revoke({ scope: "others" })}>
          Sulje muut laitteet
        </Button>
      </section>

      <form
        onSubmit={(event) => void (hasLock ? removeLock(event) : saveLock(event))}
        className="bg-white rounded-2xl p-6 shadow-sm space-y-4"
      >
        <h2 className="text-sm font-medium text-charcoal">Näytön lukitus</h2>
        <p className="text-sm text-warm-gray">
          Valinnainen koodi tällä laitteella peittää kirjanpidon, kun sovellus jää taustalle.
          Face ID tai Touch ID voi avata saman lukituksen, jos otat sen käyttöön ja sovellus on asennettu.
          Lukitus ei korvaa uloskirjautumista.
        </p>
        <label htmlFor="lockPin" className="block text-sm font-medium text-charcoal">
          {hasLock ? "Nykyinen koodi" : "Uusi koodi, 4–8 numeroa"}
        </label>
        <input
          id="lockPin"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          value={lockPin}
          onChange={(event) => setLockPin(event.target.value)}
          className={`${controlClass} min-h-12`}
        />
        {lockMsg && (
          <p className="text-sm text-warm-gray" role="status">
            {lockMsg}
          </p>
        )}
        <Button type="submit" variant={hasLock ? "secondary" : "primary"}>
          {hasLock ? "Poista lukitus" : "Ota lukitus käyttöön"}
        </Button>
        {hasLock && bio.available && !bioOn && (
          <Button type="button" variant="secondary" onClick={() => void enableBiometry()}>
            {biometricEnableLabel(bio.kind)}
          </Button>
        )}
        {hasLock && bioOn && (
          <Button type="button" variant="secondary" onClick={disableBiometry}>
            Poista biometrinen avaus
          </Button>
        )}
        {hasLock && !bio.available && (
          <p className="text-sm text-warm-gray">{biometricUnavailableCopy(bio.host)}</p>
        )}
      </form>
    </div>
  );
}
