"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import ConfirmModal from "@/components/ConfirmModal";
import { Card, PageTitle } from "@/components/ds";
import { PasswordField } from "@/components/ds/PasswordField";
import { Button } from "@/components/ui";
import {
  appLockMatches,
  clearAppLock,
  createAppLockRecord,
  readAppLock,
  subscribeAppLock,
  writeAppLock,
} from "@/lib/app-lock";
import { readDeviceBiometry, type BiometryStatus } from "@/lib/biometry";
import { hapticNotify } from "@/lib/haptics";
import { acceptableAppPin } from "@/lib/session-policy";
import { showToast } from "@/lib/toast";
import { useAccountId } from "../../useAccountId";

const PIN_MAX_LENGTH = 8;
const digitsOnly = (value: string) => value.replace(/\D/g, "").slice(0, PIN_MAX_LENGTH);

const PIN_FIELD_PROPS = {
  inputMode: "numeric",
  pattern: "[0-9]*",
  maxLength: PIN_MAX_LENGTH,
  autoComplete: "off",
  showLabel: "Näytä koodi",
  hideLabel: "Piilota koodi",
} as const;

export default function LukitusPage() {
  const lockUserId = useAccountId();
  const [pin, setPin] = useState("");
  const [repeat, setRepeat] = useState("");
  const [errors, setErrors] = useState<{ pin?: string; repeat?: string }>({});
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState(false);
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

  function fail(next: typeof errors, focusId: string) {
    setErrors(next);
    void hapticNotify("error");
    document.getElementById(focusId)?.focus();
  }

  async function saveLock(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!lockUserId) {
      fail({ pin: "Kirjaudu sisään, ennen kuin otat lukituksen käyttöön." }, "lockPin");
      return;
    }
    if (!acceptableAppPin(pin)) {
      fail({ pin: "Koodissa on oltava 4–8 numeroa." }, "lockPin");
      return;
    }
    if (repeat !== pin) {
      fail({ repeat: "Koodit eivät täsmää." }, "lockPinRepeat");
      return;
    }
    setBusy(true);
    try {
      const record = await createAppLockRecord(pin);
      if (!record) {
        fail({ pin: "Koodissa on oltava 4–8 numeroa." }, "lockPin");
        return;
      }
      writeAppLock(lockUserId, record);
      setPin("");
      setRepeat("");
      setErrors({});
      showToast({
        tone: "success",
        text: bio.available
          ? "Lukitus on päällä. Face ID / Touch ID -rivillä voit avata lukon biometrialla."
          : "Lukitus on päällä tällä laitteella.",
        durationMs: 6000,
      });
    } finally {
      setBusy(false);
    }
  }

  /** Step 1 of removal: the current code must match; only then the confirm dialog opens. */
  async function askToRemove(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    const record = readAppLock(lockUserId);
    if (!record || !lockUserId) return;
    setBusy(true);
    try {
      const ok = await appLockMatches(record, pin);
      if (!ok) {
        fail({ pin: "Koodi ei täsmää." }, "lockPin");
        return;
      }
      setErrors({});
      setConfirmRemove(true);
    } finally {
      setBusy(false);
    }
  }

  function removeLock() {
    if (!lockUserId) return;
    clearAppLock(lockUserId);
    setPin("");
    setRepeat("");
    setConfirmRemove(false);
    showToast({ tone: "success", text: "Lukitus poistettu tältä laitteelta." });
  }

  return (
    <div className="space-y-6">
      <PageTitle title="Näytön lukitus" />
      <form onSubmit={(event) => void (hasLock ? askToRemove(event) : saveLock(event))} noValidate>
        <Card className="space-y-4">
          <p className="text-caption text-ink-2 leading-relaxed">
            Valinnainen koodi tällä laitteella peittää kirjanpidon, kun sovellus jää taustalle.
            Lukitus ei korvaa uloskirjautumista.
          </p>
          <PasswordField
            id="lockPin"
            name="lockPin"
            label={hasLock ? "Nykyinen koodi" : "Uusi koodi, 4–8 numeroa"}
            enterKeyHint={hasLock ? "done" : "next"}
            {...PIN_FIELD_PROPS}
            value={pin}
            error={errors.pin}
            onChange={(event) => setPin(digitsOnly(event.target.value))}
          />
          {!hasLock && (
            <PasswordField
              id="lockPinRepeat"
              name="lockPinRepeat"
              label="Toista koodi"
              enterKeyHint="done"
              {...PIN_FIELD_PROPS}
              value={repeat}
              error={errors.repeat}
              onChange={(event) => setRepeat(digitsOnly(event.target.value))}
            />
          )}
          <Button
            type="submit"
            variant={hasLock ? "secondary" : "primary"}
            className="w-full"
            busy={busy}
            busyLabel={hasLock ? "Tarkistetaan…" : "Tallennetaan…"}
          >
            {hasLock ? "Poista lukitus" : "Ota lukitus käyttöön"}
          </Button>
        </Card>
      </form>
      <ConfirmModal
        isOpen={confirmRemove}
        title="Poistetaanko lukitus?"
        description="Kirjanpito näkyy sovelluksessa ilman koodia, kun se avataan tällä laitteella."
        confirmLabel="Poista lukitus"
        onConfirm={removeLock}
        onCancel={() => setConfirmRemove(false)}
      />
    </div>
  );
}
