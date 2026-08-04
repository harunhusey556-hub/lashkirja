"use client";

import { useEffect, useState } from "react";
import AppShell from "@/components/AppShell";
import { ErrorState, LoadingState } from "@/components/AsyncState";
import {
  errorMessage,
  isUnauthorized,
  readJson,
  redirectToLogin,
} from "@/components/clientFetch";

interface Profile {
  firstName: string;
  lastName: string;
  email: string;
  entityType: string;
  vatRegistered: boolean;
  vatPeriod: string;
}

export default function AsetuksetPage() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState("");
  const [loadError, setLoadError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/profile", { signal: controller.signal })
      .then((response) =>
        readJson<{ profile: Profile }>(
          response,
          "Asetusten lataus epäonnistui"
        )
      )
      .then((data) => {
        if (controller.signal.aborted) return;
        if (!data.profile) {
          throw new Error("Palvelin palautti virheelliset asetukset");
        }
        setLoadError("");
        setProfile(data.profile);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (isUnauthorized(error)) {
          redirectToLogin();
          return;
        }
        setLoadError(errorMessage(error, "Asetusten lataus epäonnistui"));
      });
    return () => controller.abort();
  }, [loadAttempt]);

  async function save(update: Partial<Profile>) {
    if (!profile || saving) return;
    const previous = profile;
    const next = { ...profile, ...update };
    setProfile(next);
    setSaving(true);
    setSavedMsg("");
    try {
      const res = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entityType: next.entityType,
          vatRegistered: next.vatRegistered,
          vatPeriod: next.vatPeriod,
        }),
      });
      const data = await readJson<{
        profile: Partial<Pick<Profile, "entityType" | "vatRegistered" | "vatPeriod">>;
      }>(res, "Tallennus epäonnistui");
      setProfile((current) =>
        current ? { ...current, ...data.profile } : current
      );
      setSavedMsg("Tallennettu");
    } catch (error: unknown) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      setProfile(previous);
      setSavedMsg(errorMessage(error, "Tallennus epäonnistui"));
    } finally {
      setSaving(false);
    }
  }

  if (loadError) {
    return (
      <AppShell>
        <ErrorState
          message={loadError}
          onRetry={() => {
            setLoadError("");
            setLoadAttempt((attempt) => attempt + 1);
          }}
        />
      </AppShell>
    );
  }

  if (!profile) {
    return (
      <AppShell>
        <LoadingState label="Ladataan asetuksia..." />
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="space-y-6">
        <h2 className="text-xl font-light text-charcoal">Asetukset</h2>

        <div className="bg-white rounded-2xl p-6 shadow-sm space-y-1">
          <p className="text-sm font-medium text-charcoal">
            {profile.firstName} {profile.lastName}
          </p>
          <p className="text-xs text-warm-gray">{profile.email}</p>
        </div>

        <div className="bg-white rounded-2xl p-6 shadow-sm space-y-5">
          <div>
            <label className="block text-sm font-medium text-charcoal-light mb-2">
              Yritysmuoto
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => save({ entityType: "kevytyrittaja" })}
                disabled={saving}
                aria-pressed={profile.entityType === "kevytyrittaja"}
                className={`flex-1 py-2.5 rounded-xl text-sm font-medium transition-colors ${
                  profile.entityType === "kevytyrittaja"
                    ? "bg-accent text-white"
                    : "bg-cream text-charcoal border border-warm-gray-light"
                }`}
              >
                Kevytyrittäjä
              </button>
              <button
                type="button"
                onClick={() => save({ entityType: "toiminimi" })}
                disabled={saving}
                aria-pressed={profile.entityType === "toiminimi"}
                className={`flex-1 py-2.5 rounded-xl text-sm font-medium transition-colors ${
                  profile.entityType === "toiminimi"
                    ? "bg-accent text-white"
                    : "bg-cream text-charcoal border border-warm-gray-light"
                }`}
              >
                Toiminimi
              </button>
            </div>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-charcoal-light">
                ALV-rekisterissä
              </p>
              <p className="text-xs text-warm-gray mt-0.5">
                Raja 20 000 € / kalenterivuosi
              </p>
            </div>
            <button
              type="button"
              onClick={() => save({ vatRegistered: !profile.vatRegistered })}
              disabled={saving}
              role="switch"
              aria-checked={profile.vatRegistered}
              aria-label="ALV-rekisterissä"
              className={`w-12 h-7 rounded-full transition-colors relative ${
                profile.vatRegistered ? "bg-accent" : "bg-warm-gray-light"
              }`}
            >
              <span
                className={`absolute top-1 w-5 h-5 rounded-full bg-white shadow transition-all ${
                  profile.vatRegistered ? "left-6" : "left-1"
                }`}
              />
            </button>
          </div>

          {profile.vatRegistered && (
            <div>
              <label
                htmlFor="vat-period"
                className="block text-sm font-medium text-charcoal-light mb-2"
              >
                ALV-verokausi
              </label>
              <select
                id="vat-period"
                value={profile.vatPeriod}
                onChange={(e) => save({ vatPeriod: e.target.value })}
                disabled={saving}
                className="w-full px-3 py-2.5 rounded-xl border border-warm-gray-light bg-cream/50 text-sm"
              >
                <option value="month">Kuukausi</option>
                <option value="quarter">Neljännesvuosi</option>
                <option value="year">Kalenterivuosi</option>
              </select>
            </div>
          )}

          {(saving || savedMsg) && (
            <p
              className={`text-xs ${savedMsg && savedMsg !== "Tallennettu" ? "text-danger" : "text-warm-gray"}`}
              role={savedMsg && savedMsg !== "Tallennettu" ? "alert" : "status"}
              aria-live="polite"
            >
              {saving ? "Tallennetaan..." : savedMsg}
            </p>
          )}
        </div>
      </div>
    </AppShell>
  );
}
