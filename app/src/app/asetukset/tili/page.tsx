"use client";

import { PageTitle } from "@/components/ds";
import { SettingsGroup, SettingsRow } from "@/components/SettingsList";

export default function TiliPage() {
  return (
    <div className="space-y-6">
      <PageTitle title="Tili" />
      <SettingsGroup label="Tili">
        <SettingsRow
          href="/asetukset/profiili"
          label="Profiili"
          hint="Nimi ja sähköpostiosoite"
        />
        <SettingsRow
          href="/asetukset/tili/salasana"
          label="Vaihda salasana"
          hint="Nykyinen salasana ja uusi salasana"
        />
        <SettingsRow
          href="/asetukset/tili/laitteet"
          label="Laitteet"
          hint="Kirjautuneet istunnot tällä tilillä"
        />
      </SettingsGroup>
    </div>
  );
}
