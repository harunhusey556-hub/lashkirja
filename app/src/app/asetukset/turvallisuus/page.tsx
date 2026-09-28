"use client";

import { PageTitle } from "@/components/ds";
import { SettingsGroup, SettingsRow } from "@/components/SettingsList";

export default function TurvallisuusPage() {
  return (
    <div className="space-y-6">
      <PageTitle title="Turvallisuus" />
      <SettingsGroup label="Turvallisuus">
        <SettingsRow
          href="/asetukset/turvallisuus/lukitus"
          label="Näytön lukitus"
          hint="4–8 numeron koodi tällä laitteella"
        />
        <SettingsRow
          href="/asetukset/turvallisuus/biometria"
          label="Face ID / Touch ID"
          hint="Avaa lukitus, kun palaat sovellukseen"
        />
      </SettingsGroup>
    </div>
  );
}
