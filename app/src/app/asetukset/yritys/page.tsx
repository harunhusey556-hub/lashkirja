"use client";

import { ErrorState, LoadingState } from "@/components/AsyncState";
import { SelectMenu } from "@/components/SelectMenu";
import { ENTITY_TYPE_OPTIONS } from "@/lib/onboarding";
import { SaveStatus, useProfile } from "../useProfile";

export default function YritysPage() {
  const { profile, saving, savedMsg, loadError, retry, save } = useProfile();

  if (loadError) {
    return (
      <>
        <ErrorState message={loadError} onRetry={retry} />
      </>
    );
  }

  if (!profile) {
    return (
      <>
        <LoadingState label="Ladataan asetuksia..." />
      </>
    );
  }

  return (
    <>
      <div className="space-y-6">
        <div className="bg-white rounded-2xl p-6 shadow-sm space-y-5 animate-in">
          <div>
            <label className="block text-sm font-medium text-charcoal-light mb-2">
              Yritysmuoto
            </label>
            <div className="grid grid-cols-1 gap-2">
              {ENTITY_TYPE_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => save({ entityType: option.value })}
                  disabled={saving}
                  aria-pressed={profile.entityType === option.value}
                  className={`py-2.5 rounded-xl text-sm font-medium transition-colors active-press touch-target ${
                    profile.entityType === option.value
                      ? "bg-accent text-white"
                      : "bg-cream text-charcoal border border-warm-gray-light"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-charcoal-light">
                ALV-rekisterissä
              </p>
              <p className="text-xs text-warm-gray mt-0.5">
                Raja 20 000 € / kalenterivuosi
              </p>
            </div>
            <button
              type="button"
              onClick={() => save({ vatRegistered: !profile.vatRegistered })}
              disabled={saving}
              role="switch"
              aria-checked={profile.vatRegistered}
              aria-label="ALV-rekisterissä"
              className={`w-12 h-7 rounded-full transition-colors relative after:content-[''] after:absolute after:-inset-2 ${
                profile.vatRegistered ? "bg-accent" : "bg-warm-gray-light"
              }`}
            >
              <span
                className={`absolute top-1 w-5 h-5 rounded-full bg-white shadow transition-all ${
                  profile.vatRegistered ? "left-6" : "left-1"
                }`}
              />
            </button>
          </div>

          {profile.vatRegistered && (
            <div>
              <SelectMenu
                id="vat-period"
                label="ALV-verokausi"
                value={profile.vatPeriod}
                disabled={saving}
                options={[
                  { value: "month", label: "Kuukausi", description: "OmaVero-ilmoitus kuukausittain (oletus)" },
                  { value: "quarter", label: "Neljännesvuosi", description: "OmaVero-ilmoitus 3kk välein" },
                  { value: "year", label: "Kalenterivuosi", description: "OmaVero-ilmoitus kerran vuodessa" },
                ]}
                onChange={(newVal) => save({ vatPeriod: newVal })}
              />
            </div>
          )}

          <SaveStatus saving={saving} savedMsg={savedMsg} />
        </div>
      </div>
    </>
  );
}
