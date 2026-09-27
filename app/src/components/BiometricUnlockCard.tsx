"use client";

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
    <section className="bg-white rounded-2xl p-6 shadow-sm space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 className="text-sm font-medium text-charcoal">{title}</h2>
          <p className="text-sm text-warm-gray leading-relaxed">
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
            className={`relative mt-0.5 h-8 w-14 shrink-0 rounded-full transition-colors active-press ${
              enabled ? "bg-accent" : "bg-warm-gray-light/70"
            }`}
          >
            <span
              className={`absolute top-1 h-6 w-6 rounded-full bg-white shadow-sm transition-transform ${
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
          className="w-full min-h-12 rounded-2xl bg-charcoal text-sm font-medium text-white active-press"
        >
          {biometricEnableLabel(bio.kind)}
        </button>
      )}
      {message && (
        <p className="text-sm text-warm-gray" role="status">
          {message}
        </p>
      )}
    </section>
  );
}
