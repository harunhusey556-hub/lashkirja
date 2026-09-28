"use client";

import { ErrorState, LoadingState } from "@/components/AsyncState";
import { SelectMenu } from "@/components/SelectMenu";
import { Card, FilterChips, PageTitle } from "@/components/ds";
import { ENTITY_TYPE_OPTIONS, type EntityType } from "@/lib/onboarding";
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
    <div className="space-y-6">
      <PageTitle title="Yritysmuoto & ALV" />
      <Card className="space-y-5">
        <div>
          <p className="mb-1.5 text-[13px] text-ink-2">Yritysmuoto</p>
          <FilterChips
            label="Yritysmuoto"
            wrap
            items={ENTITY_TYPE_OPTIONS.map((option) => ({ id: option.value, label: option.label }))}
            value={profile.entityType as EntityType}
            onChange={(value) => save({ entityType: value })}
          />
        </div>

        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-[15px] font-medium text-ink">ALV-rekisterissä</p>
            <p className="mt-0.5 text-[13px] text-ink-2">Raja 20 000 € / kalenterivuosi</p>
          </div>
          <button
            type="button"
            onClick={() => save({ vatRegistered: !profile.vatRegistered })}
            disabled={saving}
            role="switch"
            aria-checked={profile.vatRegistered}
            aria-label="ALV-rekisterissä"
            className={`relative h-7 w-12 shrink-0 rounded-full transition-colors after:absolute after:-inset-2 after:content-[''] ${
              profile.vatRegistered ? "bg-accent" : "bg-line"
            }`}
          >
            <span
              className={`absolute top-1 h-5 w-5 rounded-full bg-surface shadow transition-all ${
                profile.vatRegistered ? "left-6" : "left-1"
              }`}
            />
          </button>
        </div>

        {profile.vatRegistered && (
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
        )}

        <SaveStatus saving={saving} savedMsg={savedMsg} />
      </Card>
    </div>
  );
}
