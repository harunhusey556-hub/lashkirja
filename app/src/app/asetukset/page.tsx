"use client";

import Link from "next/link";
import { useState } from "react";
import { ConnectionNotice } from "@/components/ScreenState";
import { leaveAfterSignOut } from "@/components/clientFetch";
import { BriefcaseBusiness, CircleHelp, Database, Mail, ReceiptText, ShieldCheck, UserRound } from "lucide-react";
import { Card, PageTitle } from "@/components/ds";
import { SettingsChevron, SettingsGroup, SettingsRow } from "@/components/SettingsList";
import { Button } from "@/components/ui";
import { useProfile } from "./useProfile";

export default function AsetuksetPage() {
  const { profile, loadError, retry } = useProfile();
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState("");

  async function handleSignOut() {
    if (signingOut) return;
    setSigningOut(true);
    setSignOutError("");
    const left = await leaveAfterSignOut();
    if (!left) {
      setSigningOut(false);
      setSignOutError("Uloskirjautuminen epäonnistui. Istunto voi olla yhä voimassa.");
    }
  }

  if (loadError) {
    return (
      <div className="space-y-6">
        <PageTitle title="Asetukset" />
        <ConnectionNotice error={new Error(loadError)} fallback={loadError} onRetry={retry} />
      </div>
    );
  }

  const emailHint = profile
    ? profile.imapAccounts.length > 0
      ? `${profile.imapAccounts.length} tili${profile.imapAccounts.length > 1 ? "ä" : ""} yhdistetty`
      : "Ei yhdistettyjä tilejä"
    : undefined;

  return (
    <div className="space-y-6">
      <PageTitle title="Asetukset" />

      {/* Profile summary: tap through to the editable profile page. */}
      {profile ? (
        <Link href="/asetukset/profiili" className="active-press block">
          <Card className="flex items-center gap-4">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-accent-soft text-lg font-semibold text-accent">
              {(profile.firstName?.[0] || "?").toUpperCase()}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px] font-medium text-ink">
                {profile.firstName} {profile.lastName}
              </span>
              <span className="mt-0.5 block truncate text-[13px] text-ink-2">{profile.email}</span>
            </span>
            <SettingsChevron />
          </Card>
        </Link>
      ) : (
        <Card className="flex items-center gap-4">
          <div className="h-12 w-12 shrink-0 animate-pulse rounded-full bg-line/60" />
          <div className="flex-1 space-y-2">
            <div className="h-4 w-32 animate-pulse rounded bg-line/60" />
            <div className="h-3 w-44 animate-pulse rounded bg-line/40" />
          </div>
        </Card>
      )}

      <SettingsGroup label="Yritys">
        <SettingsRow
          href="/asetukset/yritys"
          icon={BriefcaseBusiness}
          label="Yritysmuoto & ALV"
          hint="Kevytyrittäjä tai toiminimi, ALV-rekisteri ja verokausi"
        />
        <SettingsRow
          href="/asetukset/laskutus"
          icon={ReceiptText}
          label="Laskuttajan tiedot"
          hint="Y-tunnus, tilinumero ja laskun tiedot"
        />
      </SettingsGroup>

      <SettingsGroup label="Tili">
        <SettingsRow href="/asetukset/tili" icon={UserRound} label="Tili" hint="Salasana ja kirjautuneet laitteet" />
        <SettingsRow
          href="/asetukset/turvallisuus"
          icon={ShieldCheck}
          label="Turvallisuus"
          hint="Näytön koodi ja Face ID"
        />
        <SettingsRow
          href="/asetukset/tietosuoja"
          icon={Database}
          label="Tietosuoja ja tiedot"
          hint="Mihin tiedot menevät, säilytys ja tilin sulku"
        />
      </SettingsGroup>

      <SettingsGroup label="Integraatiot">
        <SettingsRow href="/asetukset/sahkoposti" icon={Mail} label="Sähköpostien tuonti" hint={emailHint} />
      </SettingsGroup>

      <SettingsGroup label="Ohje">
        <SettingsRow href="/asetukset/ohje" icon={CircleHelp} label="Ohje ja tuki" hint="Virheviite ja tukiviesti" />
      </SettingsGroup>

      {signOutError && (
        <p className="px-1 text-sm text-danger" role="alert">
          {signOutError}
        </p>
      )}
      <Button
        type="button"
        variant="danger"
        className="w-full"
        onClick={handleSignOut}
        busy={signingOut}
        busyLabel="Kirjaudutaan ulos…"
      >
        Kirjaudu ulos
      </Button>
    </div>
  );
}
