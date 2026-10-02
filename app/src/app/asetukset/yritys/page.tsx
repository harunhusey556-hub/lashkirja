"use client";

import { CustomSelect } from "@/components/CustomSelect";

import { Field, controlClass } from "@/components/ui";
import { Switch } from "@/components/ds/Switch";
import { Card, FilterChips, PageTitle } from "@/components/ds";
import { ENTITY_TYPE_OPTIONS, type EntityType } from "@/lib/onboarding";
import { showToast } from "@/lib/toast";
import { ProfileGate } from "../ProfileGate";
import { type Profile, SaveStatus, useProfile } from "../useProfile";

const VAT_PERIOD_OPTIONS = [
  { value: "month", label: "Kuukausi", description: "OmaVero-ilmoitus kuukausittain (oletus)." },
  { value: "quarter", label: "Neljännesvuosi", description: "OmaVero-ilmoitus 3 kuukauden välein." },
  { value: "year", label: "Kalenterivuosi", description: "OmaVero-ilmoitus kerran vuodessa." },
] as const;

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
              <Switch
                checked={loaded.vatRegistered}
                onChange={() =>
                  void change(
                    loaded,
                    { vatRegistered: !loaded.vatRegistered },
                    loaded.vatRegistered ? "ALV-rekisteri poistettu käytöstä" : "ALV-rekisteri otettu käyttöön"
                  )
                }
                disabled={saving}
                label="ALV-rekisterissä"
              />
            </div>

            {loaded.vatRegistered && (
              // VS-17: the one select pattern, the native <CustomSelect> in `controlClass`.
              <Field
                label="ALV-verokausi"
                htmlFor="vat-period"
                hint={VAT_PERIOD_OPTIONS.find((option) => option.value === loaded.vatPeriod)?.description}
              >
                <CustomSelect
                  className={controlClass}
                  value={loaded.vatPeriod}
                  disabled={saving}
                  autoComplete="off"
                  onChange={(event) => void change(loaded, { vatPeriod: event.target.value }, "ALV-verokausi vaihdettu")}
                >
                  {VAT_PERIOD_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </CustomSelect>
              </Field>
            )}

            <SaveStatus saving={saving} savedMsg={savedMsg} />
          </Card>
        </>
      )}
    </ProfileGate>
  );
}
