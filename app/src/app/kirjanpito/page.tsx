import { SettingsGroup, SettingsRow } from "@/components/SettingsList";

/**
 * Phase 1 hub: one place for everything bookkeeping. Phase 2 replaces the
 * first group with the single transaction list (spec §3.2).
 */
export default function KirjanpitoPage() {
  return (
    <div className="space-y-6 pb-6">
      <SettingsGroup label="Tapahtumat ja kuitit">
        <SettingsRow href="/kuitit" label="Kuitit" hint="Kaikki kuitit ja niiden tila" />
        <SettingsRow href="/pankki/tapahtumat" label="Tapahtumat" hint="Tiliotteet ja yhdistetyn pankin tapahtumat" />
        <SettingsRow href="/pankki/taydennys" label="Täsmäytys" hint="Kuitit ja tapahtumat ilman linkkiä" />
        <SettingsRow href="/tyot" label="Työt ja poikkeukset" hint="Taustatyöt ja avoimet poikkeukset" />
      </SettingsGroup>
      <SettingsGroup label="Ilmoitukset ja kaudet">
        <SettingsRow href="/kirjanpito/alv" label="ALV-ilmoitus" hint="OmaVero-kentät kuukaudelle tai neljännekselle" />
        <SettingsRow href="/kirjanpito/ostolaskut" label="Ostolaskut" hint="Mitä olet velkaa ja milloin" />
        <SettingsRow href="/kirjanpito/pankkitilit" label="Pankkitilit" hint="Tilit, saldot ja pankkiyhteys" />
        <SettingsRow href="/kirjanpito/kaudet" label="Suljetut kaudet" hint="Sulje valmiit kuukaudet muutoksilta" />
      </SettingsGroup>
    </div>
  );
}
