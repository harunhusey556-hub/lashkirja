"use client";

import Link from "next/link";
import { useState } from "react";
import { ConnectionNotice } from "@/components/ScreenState";
import { leaveAfterSignOut } from "@/components/clientFetch";
import { SettingsChevron, SettingsGroup, SettingsRow } from "@/components/SettingsList";
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
    <>
      <div className="space-y-6 list-stagger">
        {/* Profile header: tap through to the editable profile page. */}
        {profile ? (
          <Link
            href="/asetukset/profiili"
            className="flex items-center gap-4 bg-white rounded-2xl p-4 shadow-sm transition-colors active:bg-blush/30"
          >
            <span className="w-12 h-12 rounded-full bg-blush text-accent-dark text-lg font-semibold flex items-center justify-center border border-blush-dark/40 shrink-0">
              {(profile.firstName?.[0] || "?").toUpperCase()}
            </span>
            <span className="flex-1 min-w-0">
              <span className="block text-base font-medium text-charcoal truncate">
                {profile.firstName} {profile.lastName}
              </span>
              <span className="block text-xs text-warm-gray truncate mt-0.5">
                {profile.email}
              </span>
            </span>
            <SettingsChevron />
          </Link>
        ) : (
          <div className="flex items-center gap-4 bg-white rounded-2xl p-4 shadow-sm">
            <div className="w-12 h-12 rounded-full bg-warm-gray-light/30 skeleton shrink-0" />
            <div className="flex-1 space-y-2">
              <div className="w-32 h-4 bg-warm-gray-light/30 rounded skeleton" />
              <div className="w-44 h-3 bg-warm-gray-light/20 rounded skeleton" />
            </div>
          </div>
        )}

        <SettingsGroup label="Yritys">
          <SettingsRow
            href="/asetukset/yritys"
            label="Yritysmuoto & ALV"
            hint="Kevytyrittäjä tai toiminimi, ALV-rekisteri ja verokausi"
          />
          <SettingsRow
            href="/asetukset/laskutus"
            label="Laskuttajan tiedot"
            hint="Y-tunnus, tilinumero ja laskun tiedot"
          />
        </SettingsGroup>

        <SettingsGroup label="Tili">
          <SettingsRow
            href="/asetukset/tili"
            label="Tili"
            hint="Salasana ja kirjautuneet laitteet"
          />
          <SettingsRow
            href="/asetukset/turvallisuus"
            label="Turvallisuus"
            hint="Näytön koodi ja Face ID"
          />
          <SettingsRow
            href="/asetukset/tietosuoja"
            label="Tietosuoja ja tiedot"
            hint="Mihin tiedot menevät, säilytys ja tilin sulku"
          />
        </SettingsGroup>

        <SettingsGroup label="Integraatiot">
          <SettingsRow
            href="/asetukset/sahkoposti"
            label="Sähköpostien tuonti"
            hint={emailHint}
          />
        </SettingsGroup>

        <SettingsGroup label="Ohje">
          <SettingsRow
            href="/asetukset/ohje"
            label="Ohje ja tuki"
            hint="Virheviite ja tukiviesti"
          />
        </SettingsGroup>

        {signOutError && (
          <p className="text-sm text-danger px-1" role="alert">
            {signOutError}
          </p>
        )}
        <button
          type="button"
          onClick={handleSignOut}
          disabled={signingOut}
          className="w-full flex items-center justify-center gap-2 py-3.5 rounded-2xl bg-white shadow-sm text-sm font-medium text-danger transition-colors active:bg-danger/10 disabled:opacity-60 touch-target active-press"
        >
          {signingOut && (
            <span
              className="w-4 h-4 border-2 border-danger/40 border-t-danger rounded-full animate-spin motion-reduce:animate-none"
              aria-hidden
            />
          )}
          {signingOut ? "Kirjaudutaan ulos…" : "Kirjaudu ulos"}
        </button>
      </div>
    </>
  );
}
