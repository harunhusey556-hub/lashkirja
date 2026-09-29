"use client";

import Link from "next/link";
import { ConnectionNotice } from "@/components/ScreenState";
import { BriefcaseBusiness, CircleHelp, Database, Mail, ReceiptText, ShieldCheck } from "lucide-react";
import { Card, PageTitle, Skeleton } from "@/components/ds";
import { SettingsChevron, SettingsGroup, SettingsRow } from "@/components/SettingsList";
import { Button } from "@/components/ui";
import { useSignOut } from "@/components/useSignOut";
import { useProfile } from "./useProfile";

export default function AsetuksetPage() {
  const { profile, loadError, retry } = useProfile();
  const { requestSignOut, signingOut, signOutError, confirmDialog } = useSignOut();

  const emailHint = profile
    ? profile.imapAccounts.length > 0
      ? `${profile.imapAccounts.length} tili${profile.imapAccounts.length > 1 ? "ä" : ""} yhdistetty`
      : "Ei yhdistettyjä tilejä"
    : undefined;

  return (
    <div className="space-y-6">
      <PageTitle title="Asetukset" />

      {/* A failed profile load never hides the rest: the rows do not need it,
          and "Kirjaudu ulos" must stay reachable. */}
      {loadError && !profile && (
        <ConnectionNotice error={new Error(loadError)} fallback={loadError} onRetry={retry} compact />
      )}

      {/* Profile summary: tap through to the editable profile page. */}
      {profile ? (
        <Link href="/asetukset/profiili" className="active-press block">
          <Card className="flex items-center gap-4">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-accent-soft text-lg font-semibold text-accent">
              {(profile.firstName?.[0] || "?").toUpperCase()}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-body font-medium text-ink">
                {profile.firstName} {profile.lastName}
              </span>
              <span className="mt-0.5 block truncate text-caption text-ink-2">{profile.email}</span>
            </span>
            <SettingsChevron />
          </Card>
        </Link>
      ) : loadError ? null : (
        <Card className="flex items-center gap-4">
          <Skeleton className="h-12 w-12 shrink-0" radius="full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-44" tone="soft" />
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
        <SettingsRow
          href="/asetukset/tili"
          icon={ShieldCheck}
          label="Tili ja turvallisuus"
          hint="Salasana, laitteet, näytön koodi ja Face ID"
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
        <SettingsRow href="/asetukset/ohje" icon={CircleHelp} label="Ohje ja tuki" hint="Ilmoita ongelmasta ja yhteystiedot" />
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
        onClick={requestSignOut}
        busy={signingOut}
        busyLabel="Kirjaudutaan ulos…"
      >
        Kirjaudu ulos
      </Button>
      {confirmDialog}
    </div>
  );
}
