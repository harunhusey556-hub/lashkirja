"use client";

import { Card } from "@/components/ds";
import {
  biometricEnableLabel,
  biometricUnavailableCopy,
  biometricUnlockLabel,
  type BiometryStatus,
} from "@/lib/biometry";

export function BiometricUnlockCard({
  hasLock,
  bio,
  enabled,
  message,
  onEnable,
  onDisable,
}: {
  hasLock: boolean;
  bio: BiometryStatus;
  enabled: boolean;
  message?: string;
  onEnable: () => void;
  onDisable: () => void;
}) {
  const title = bio.kind === "touch" ? "Touch ID" : bio.kind === "face" ? "Face ID" : "Face ID / Touch ID";
  const ready = hasLock && bio.available;

  return (
    <Card className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 className="text-[15px] font-medium text-ink">{title}</h2>
          <p className="text-[13px] text-ink-2 leading-relaxed">
            {ready
              ? enabled
                ? `${biometricUnlockLabel(bio.kind)} kysytään, kun palaat sovellukseen. Koodi jää varalle.`
                : "Kytke päälle, niin lukitus aukeaa biometrialla. Koodi jää varalle, jos peruutat."
              : hasLock
                ? biometricUnavailableCopy(bio.host, bio.gap === "missing-plugin" ? "missing-plugin" : "unsupported")
                : "Aseta ensin näytön koodi. Sen jälkeen voit avata saman lukon Face ID:llä tai Touch ID:llä."}
          </p>
        </div>
        {ready && (
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label={enabled ? "Biometrinen avaus päällä" : biometricEnableLabel(bio.kind)}
            onClick={() => (enabled ? onDisable() : onEnable())}
            className={`relative mt-0.5 h-8 w-14 shrink-0 rounded-full transition-colors active-press before:absolute before:inset-x-0 before:-inset-y-1.5 before:content-[''] ${
              enabled ? "bg-accent" : "bg-line"
            }`}
          >
            <span
              className={`absolute top-1 h-6 w-6 rounded-full bg-surface shadow-sm transition-transform ${
                enabled ? "translate-x-7" : "translate-x-1"
              }`}
            />
          </button>
        )}
      </div>
      {ready && !enabled && (
        <button
          type="button"
          onClick={onEnable}
          className="active-press min-h-12 w-full rounded-card bg-ink text-[15px] font-semibold text-canvas"
        >
          {biometricEnableLabel(bio.kind)}
        </button>
      )}
      {message && (
        <p className="text-sm text-ink-2" role="status">
          {message}
        </p>
      )}
    </Card>
  );
}
