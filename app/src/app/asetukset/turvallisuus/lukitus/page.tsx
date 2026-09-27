"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { Button, controlClass } from "@/components/ui";
import {
  appLockMatches,
  clearAppLock,
  createAppLockRecord,
  readAppLock,
  subscribeAppLock,
  writeAppLock,
} from "@/lib/app-lock";
import { readDeviceBiometry, type BiometryStatus } from "@/lib/biometry";
import { useAccountId } from "../../useAccountId";

export default function LukitusPage() {
  const lockUserId = useAccountId();
  const [lockPin, setLockPin] = useState("");
  const [lockMsg, setLockMsg] = useState("");
  const hasLock = useSyncExternalStore(
    subscribeAppLock,
    () => Boolean(lockUserId && readAppLock(lockUserId)),
    () => false
  );
  const [bio, setBio] = useState<BiometryStatus>({
    available: false,
    kind: "none",
    host: "web",
    gap: "unsupported",
  });

  useEffect(() => {
    let cancelled = false;
    void readDeviceBiometry().then((status) => {
      if (!cancelled) setBio(status);
    });
    return () => {
      cancelled = true;
    };
  }, []);

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
        ? "Lukitus on päällä tällä laitteella. Avaa Face ID / Touch ID -rivi, jos haluat avata lukon biometrialla."
        : "Lukitus on päällä tällä laitteella. Se ei kirjaa sinua ulos palvelimelta."
    );
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
    <form
      onSubmit={(event) => void (hasLock ? removeLock(event) : saveLock(event))}
      className="bg-white rounded-2xl p-6 shadow-sm space-y-4"
    >
      <h2 className="text-sm font-medium text-charcoal">Näytön lukitus</h2>
      <p className="text-sm text-warm-gray">
        Valinnainen koodi tällä laitteella peittää kirjanpidon, kun sovellus jää taustalle.
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
    </form>
  );
}
