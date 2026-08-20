"use client";

import Link from "next/link";
import { useState } from "react";
import AppShell from "@/components/AppShell";
import { ErrorState } from "@/components/AsyncState";
import { signOut } from "@/components/clientFetch";
import { useProfile } from "./useProfile";

function Chevron() {
  return (
    <svg
      className="w-4 h-4 text-warm-gray-light shrink-0"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      aria-hidden
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
    </svg>
  );
}

function SettingsGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3 className="px-4 mb-2 text-xs font-medium uppercase tracking-widest text-warm-gray">
        {label}
      </h3>
      <div className="bg-white rounded-2xl shadow-sm overflow-hidden divide-y divide-warm-gray-light/25">
        {children}
      </div>
    </section>
  );
}

function SettingsRow({
  href,
  label,
  hint,
}: {
  href: string;
  label: string;
  hint?: string;
}) {
  return (
    <Link
      href={href}
      className="flex items-center gap-3 px-4 py-3.5 transition-colors active:bg-blush/30 touch-target"
    >
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-medium text-charcoal">{label}</span>
        {hint && (
          <span className="block text-xs text-warm-gray truncate mt-0.5">{hint}</span>
        )}
      </span>
      <Chevron />
    </Link>
  );
}

export default function AsetuksetPage() {
  const { profile, loadError, retry } = useProfile();
  const [signingOut, setSigningOut] = useState(false);

  async function handleSignOut() {
    if (signingOut) return;
    setSigningOut(true);
    await signOut();
  }

  if (loadError) {
    return (
      <AppShell>
        <ErrorState message={loadError} onRetry={retry} />
      </AppShell>
    );
  }

  const emailHint = profile
    ? profile.imapAccounts.length > 0
      ? `${profile.imapAccounts.length} tili${profile.imapAccounts.length > 1 ? "ä" : ""} yhdistetty`
      : "Ei yhdistettyjä tilejä"
    : undefined;

  return (
    <AppShell>
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
            <Chevron />
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
          <SettingsRow
            href="/asetukset/kirjanpito"
            label="Kirjanpidon lukitus"
            hint="Sulje valmiit kaudet muutoksilta"
          />
        </SettingsGroup>

        <SettingsGroup label="Automaatio">
          <SettingsRow
            href="/asetukset/sahkoposti"
            label="Sähköpostien tuonti"
            hint={emailHint}
          />
        </SettingsGroup>

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
    </AppShell>
  );
}
