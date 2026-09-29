"use client";

import { Lock, ScanFace } from "lucide-react";
import { PageTitle } from "@/components/ds";
import { SettingsGroup, SettingsRow } from "@/components/SettingsList";

export default function TurvallisuusPage() {
  return (
    <div className="space-y-6">
      <PageTitle title="Turvallisuus" />
      <SettingsGroup label="Tämä laite">
        <SettingsRow
          href="/asetukset/turvallisuus/lukitus"
          icon={Lock}
          label="Näytön lukitus"
          hint="4–8 numeron koodi tällä laitteella"
        />
        <SettingsRow
          href="/asetukset/turvallisuus/biometria"
          icon={ScanFace}
          label="Face ID / Touch ID"
          hint="Avaa lukitus tunnistautumalla"
        />
      </SettingsGroup>
    </div>
  );
}
