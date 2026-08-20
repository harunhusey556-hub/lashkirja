"use client";

import { useState } from "react";
import AppShell from "@/components/AppShell";
import { ErrorState, LoadingState } from "@/components/AsyncState";
import { type Profile, SaveStatus, useProfile } from "../useProfile";

export default function ProfiiliPage() {
  const { profile, saving, savedMsg, loadError, retry, save } = useProfile();

  if (loadError) {
    return (
      <AppShell>
        <ErrorState message={loadError} onRetry={retry} />
      </AppShell>
    );
  }

  if (!profile) {
    return (
      <AppShell>
        <LoadingState label="Ladataan profiilia..." />
      </AppShell>
    );
  }

  return (
    <AppShell>
      <ProfileForm
        profile={profile}
        saving={saving}
        savedMsg={savedMsg}
        save={save}
      />
    </AppShell>
  );
}

function ProfileForm({
  profile,
  saving,
  savedMsg,
  save,
}: {
  profile: Profile;
  saving: boolean;
  savedMsg: string;
  save: (update: Partial<Profile>) => Promise<boolean>;
}) {
  // Mounted only once the profile exists, so the form seeds itself here and
  // the user owns the values from then on.
  const [firstName, setFirstName] = useState(profile.firstName);
  const [lastName, setLastName] = useState(profile.lastName);
  const [email, setEmail] = useState(profile.email);

  const dirty =
    firstName !== profile.firstName ||
    lastName !== profile.lastName ||
    email !== profile.email;

  return (
    <div className="space-y-6">
        <div className="flex items-center gap-4 animate-in">
          <span className="w-14 h-14 rounded-full bg-blush text-accent-dark text-xl font-semibold flex items-center justify-center border border-blush-dark/40">
            {(profile.firstName?.[0] || "?").toUpperCase()}
          </span>
          <div className="min-w-0">
            <p className="text-lg font-medium text-charcoal truncate">
              {profile.firstName} {profile.lastName}
            </p>
            <p className="text-sm text-warm-gray truncate">{profile.email}</p>
          </div>
        </div>

        <form
          className="bg-white rounded-2xl p-6 shadow-sm space-y-4 animate-in-delay-1"
          onSubmit={(event) => {
            event.preventDefault();
            save({ firstName, lastName, email });
          }}
        >
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label
                htmlFor="firstName"
                className="block text-sm font-medium text-charcoal mb-1.5"
              >
                Etunimi
              </label>
              <input
                id="firstName"
                type="text"
                required
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl border border-warm-gray-light bg-white text-sm"
              />
            </div>
            <div>
              <label
                htmlFor="lastName"
                className="block text-sm font-medium text-charcoal mb-1.5"
              >
                Sukunimi
              </label>
              <input
                id="lastName"
                type="text"
                required
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl border border-warm-gray-light bg-white text-sm"
              />
            </div>
          </div>
          <div>
            <label
              htmlFor="email"
              className="block text-sm font-medium text-charcoal mb-1.5"
            >
              Sähköposti
            </label>
            <input
              id="email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3 py-2.5 rounded-xl border border-warm-gray-light bg-white text-sm"
            />
          </div>

          <div className="flex items-center justify-between gap-3 pt-1">
            <SaveStatus saving={saving} savedMsg={savedMsg} />
            <button
              type="submit"
              disabled={saving || !dirty}
              className="ml-auto px-5 py-2.5 rounded-xl bg-accent text-white text-sm font-medium hover:bg-accent-dark disabled:opacity-50 transition-colors active-press touch-target"
            >
              Tallenna
            </button>
          </div>
        </form>
    </div>
  );
}
