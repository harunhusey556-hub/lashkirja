"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { BiometricUnlockCard } from "@/components/BiometricUnlockCard";
import { readAppLock, readBiometricUnlock, subscribeAppLock, writeBiometricUnlock } from "@/lib/app-lock";
import { readDeviceBiometry, unlockWithBiometry, type BiometryStatus } from "@/lib/biometry";
import { useAccountId } from "../../useAccountId";

export default function BiometriaPage() {
  const lockUserId = useAccountId();
  const [lockMsg, setLockMsg] = useState("");
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

  async function enableBiometry() {
    if (!lockUserId || !hasLock) return;
    const result = await unlockWithBiometry();
    if (result !== "ok") {
      setLockMsg("Biometria ei vahvistunut. Koodi jää käyttöön.");
      return;
    }
    writeBiometricUnlock(lockUserId, true);
    setLockMsg("Biometrinen avaus on päällä. Se kysytään, kun palaat sovellukseen.");
  }

  function disableBiometry() {
    if (!lockUserId) return;
    writeBiometricUnlock(lockUserId, false);
    setLockMsg("Biometrinen avaus poistettu. Koodi jää käyttöön.");
  }

  return (
    <BiometricUnlockCard
      hasLock={hasLock}
      bio={bio}
      enabled={bioOn}
      message={lockMsg}
      onEnable={() => void enableBiometry()}
      onDisable={disableBiometry}
    />
  );
}
