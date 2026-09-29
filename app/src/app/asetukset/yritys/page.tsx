"use client";

import { SelectMenu } from "@/components/SelectMenu";
import { Card, FilterChips, PageTitle } from "@/components/ds";
import { ENTITY_TYPE_OPTIONS, type EntityType } from "@/lib/onboarding";
import { showToast } from "@/lib/toast";
import { ProfileGate } from "../ProfileGate";
import { type Profile, SaveStatus, useProfile } from "../useProfile";

export default function YritysPage() {
  const { profile, saving, savedMsg, loadError, retry, save } = useProfile();

  /**
   * AUTH-30: a change saves on tap (the control flips at once and rolls back
   * if the save fails, with the error under the card), and a successful one
   * offers "Kumoa" for a few seconds instead of asking first.
   */
  async function change<K extends keyof Profile>(current: Profile, update: Pick<Profile, K>, text: string) {
    const previous = {} as Pick<Profile, K>;
    for (const key of Object.keys(update) as K[]) previous[key] = current[key];
    const ok = await save(update);
    if (!ok) return;
    showToast({
      tone: "info",
      text,
      haptic: false,
      action: { label: "Kumoa", onAction: () => void save(previous) },
    });
  }

  return (
    <ProfileGate
      profile={profile}
      loadError={loadError}
      retry={retry}
      title="Yritysmuoto & ALV"
      skeletonLabel="Ladataan asetuksia"
      fields={2}
    >
      {(loaded) => (
        <>
          <PageTitle title="Yritysmuoto & ALV" />
          <Card className="space-y-5">
            <FilterChips
              label="Yritysmuoto"
              wrap
              items={ENTITY_TYPE_OPTIONS.map((option) => ({ id: option.value, label: option.label }))}
              value={loaded.entityType as EntityType}
              onChange={(value) => void change(loaded, { entityType: value }, "Yritysmuoto vaihdettu")}
            />

            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-body font-medium text-ink">ALV-rekisterissä</p>
                <p className="mt-0.5 text-caption text-ink-2">Raja 20 000 € / kalenterivuosi</p>
              </div>
              <button
                type="button"
                onClick={() =>
                  void change(
                    loaded,
                    { vatRegistered: !loaded.vatRegistered },
                    loaded.vatRegistered ? "ALV-rekisteri poistettu käytöstä" : "ALV-rekisteri otettu käyttöön"
                  )
                }
                disabled={saving}
                role="switch"
                aria-checked={loaded.vatRegistered}
                aria-label="ALV-rekisterissä"
                className={`relative h-7 w-12 shrink-0 rounded-full transition-colors after:absolute after:-inset-2 after:content-[''] ${
                  loaded.vatRegistered ? "bg-accent" : "bg-line"
                }`}
              >
                <span
                  className={`absolute top-1 h-5 w-5 rounded-full bg-surface shadow transition-all ${
                    loaded.vatRegistered ? "left-6" : "left-1"
                  }`}
                />
              </button>
            </div>

            {loaded.vatRegistered && (
              <SelectMenu
                id="vat-period"
                label="ALV-verokausi"
                value={loaded.vatPeriod}
                disabled={saving}
                options={[
                  { value: "month", label: "Kuukausi", description: "OmaVero-ilmoitus kuukausittain (oletus)" },
                  { value: "quarter", label: "Neljännesvuosi", description: "OmaVero-ilmoitus 3kk välein" },
                  { value: "year", label: "Kalenterivuosi", description: "OmaVero-ilmoitus kerran vuodessa" },
                ]}
                onChange={(newVal) => void change(loaded, { vatPeriod: newVal }, "ALV-verokausi vaihdettu")}
              />
            )}

            <SaveStatus saving={saving} savedMsg={savedMsg} />
          </Card>
        </>
      )}
    </ProfileGate>
  );
}
