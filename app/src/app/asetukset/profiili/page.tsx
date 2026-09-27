"use client";

import { useState } from "react";
import { ErrorState, LoadingState } from "@/components/AsyncState";
import { apiFetch, errorMessage, readJson } from "@/components/clientFetch";
import { type Profile, SaveStatus, useProfile } from "../useProfile";
import { Button, controlClass } from "@/components/ui";

export default function ProfiiliPage() {
  const { profile, saving, savedMsg, loadError, retry, save } = useProfile();

  if (loadError) {
    return (
      <>
        <ErrorState message={loadError} onRetry={retry} />
      </>
    );
  }

  if (!profile) {
    return (
      <>
        <LoadingState label="Ladataan profiilia..." />
      </>
    );
  }

  return (
    <>
      <ProfileForm
        profile={profile}
        saving={saving}
        savedMsg={savedMsg}
        save={save}
      />
    </>
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
  const [email, setEmail] = useState(profile.pendingEmail || "");
  const [currentPassword, setCurrentPassword] = useState("");
  const [emailMsg, setEmailMsg] = useState("");
  const [emailBusy, setEmailBusy] = useState(false);

  const dirty = firstName !== profile.firstName || lastName !== profile.lastName;

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
            save({ firstName, lastName });
          }}
        >
          <div className="field-grid">
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
                className={`${controlClass} min-h-12`}
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
                className={`${controlClass} min-h-12`}
              />
            </div>
          </div>
          <p className="text-sm text-warm-gray">
            Kirjautumissähköposti on {profile.email}. Uusi osoite otetaan käyttöön vasta vahvistuslinkin jälkeen.
          </p>

          <div className="flex items-center justify-between gap-3 pt-1">
            <SaveStatus saving={saving} savedMsg={savedMsg} />
            <Button type="submit" busy={saving} busyLabel="Tallennetaan…" disabled={!dirty} className="ml-auto">
              Tallenna
            </Button>
          </div>
        </form>

        <form
          className="bg-white rounded-2xl p-6 shadow-sm space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            setEmailBusy(true);
            setEmailMsg("");
            void apiFetch("/api/auth/email", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ email, currentPassword }),
            })
              .then((response) =>
                readJson<{ message: string }>(response, "Sähköpostin vaihto epäonnistui")
              )
              .then((data) => {
                setEmailMsg(data.message);
                setCurrentPassword("");
              })
              .catch((error: unknown) => {
                setEmailMsg(errorMessage(error, "Sähköpostin vaihto epäonnistui"));
              })
              .finally(() => setEmailBusy(false));
          }}
        >
          <h2 className="text-sm font-medium text-charcoal">Vaihda sähköposti</h2>
          {profile.pendingEmail && (
            <p className="text-sm text-warm-gray">
              Odottaa vahvistusta: {profile.pendingEmail}. Nykyinen osoite toimii siihen asti.
            </p>
          )}
          <div>
            <label htmlFor="newEmail" className="block text-sm font-medium text-charcoal mb-1.5">
              Uusi sähköposti
            </label>
            <input
              id="newEmail"
              type="email"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className={`${controlClass} min-h-12`}
            />
          </div>
          <div>
            <label htmlFor="emailPassword" className="block text-sm font-medium text-charcoal mb-1.5">
              Nykyinen salasana
            </label>
            <input
              id="emailPassword"
              type="password"
              autoComplete="current-password"
              required
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              className={`${controlClass} min-h-12`}
            />
          </div>
          {emailMsg && (
            <p className="text-sm text-warm-gray" role="status">
              {emailMsg}
            </p>
          )}
          <Button type="submit" busy={emailBusy} busyLabel="Lähetetään…" className="ml-auto">
            Lähetä vahvistus
          </Button>
        </form>
    </div>
  );
}
