"use client";

import { KeyRound, Smartphone, UserRound } from "lucide-react";
import { PageTitle } from "@/components/ds";
import { SettingsGroup, SettingsRow } from "@/components/SettingsList";

export default function TiliPage() {
  return (
    <div className="space-y-6">
      <PageTitle title="Tili" />
      <SettingsGroup label="Tili">
        <SettingsRow
          href="/asetukset/profiili"
          icon={UserRound}
          label="Profiili"
          hint="Nimi ja sähköpostiosoite"
        />
        <SettingsRow
          href="/asetukset/tili/salasana"
          icon={KeyRound}
          label="Vaihda salasana"
          hint="Nykyinen salasana ja uusi salasana"
        />
        <SettingsRow
          href="/asetukset/tili/laitteet"
          icon={Smartphone}
          label="Laitteet"
          hint="Kirjautuneet istunnot tällä tilillä"
        />
      </SettingsGroup>
    </div>
  );
}
