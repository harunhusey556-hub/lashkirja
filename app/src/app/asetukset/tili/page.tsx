"use client";

import { KeyRound, Lock, ScanFace, Smartphone } from "lucide-react";
import { PageTitle } from "@/components/ds";
import { SettingsGroup, SettingsRow } from "@/components/SettingsList";

/** AUTH-29: the one home for sign-in and device security (it used to be split
 * over "Tili" and "Turvallisuus", with "Profiili" repeated from the parent). */
export default function TiliPage() {
  return (
    <div className="space-y-6">
      <PageTitle title="Tili ja turvallisuus" />
      <SettingsGroup label="Kirjautuminen">
        <SettingsRow
          href="/asetukset/tili/salasana"
          icon={KeyRound}
          label="Vaihda salasana"
          hint="Nykyinen ja uusi salasana"
        />
        <SettingsRow
          href="/asetukset/tili/laitteet"
          icon={Smartphone}
          label="Laitteet"
          hint="Missä olet kirjautuneena"
        />
      </SettingsGroup>
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
