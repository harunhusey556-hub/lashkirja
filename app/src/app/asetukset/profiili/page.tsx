"use client";

import { useState } from "react";
import { ErrorState, LoadingState } from "@/components/AsyncState";
import { apiFetch, errorMessage, readJson } from "@/components/clientFetch";
import { type Profile, SaveStatus, useProfile } from "../useProfile";
import { Card, PageTitle } from "@/components/ds";
import { Button, Field } from "@/components/ui";
import { controlClass } from "@/components/control-styles";

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
    <div className="space-y-6">
      <PageTitle title="Profiili" />
      <ProfileForm profile={profile} saving={saving} savedMsg={savedMsg} save={save} />
    </div>
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
      <Card className="flex items-center gap-4">
        <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xl font-semibold text-accent">
          {(profile.firstName?.[0] || "?").toUpperCase()}
        </span>
        <div className="min-w-0">
          <p className="truncate text-[15px] font-medium text-ink">
            {profile.firstName} {profile.lastName}
          </p>
          <p className="truncate text-[13px] text-ink-2">{profile.email}</p>
        </div>
      </Card>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          save({ firstName, lastName });
        }}
      >
        <Card className="space-y-4">
          <div className="field-grid">
            <Field label="Etunimi" htmlFor="firstName">
              <input
                id="firstName"
                type="text"
                required
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                className={controlClass}
              />
            </Field>
            <Field label="Sukunimi" htmlFor="lastName">
              <input
                id="lastName"
                type="text"
                required
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                className={controlClass}
              />
            </Field>
          </div>
          <p className="text-[13px] text-ink-2">
            Kirjautumissähköposti on {profile.email}. Uusi osoite otetaan käyttöön vasta vahvistuslinkin jälkeen.
          </p>

          <SaveStatus saving={saving} savedMsg={savedMsg} />
          <Button type="submit" busy={saving} busyLabel="Tallennetaan…" disabled={!dirty} className="w-full">
            Tallenna
          </Button>
        </Card>
      </form>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          setEmailBusy(true);
          setEmailMsg("");
          void apiFetch("/api/auth/email", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, currentPassword }),
          })
            .then((response) => readJson<{ message: string }>(response, "Sähköpostin vaihto epäonnistui"))
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
        <Card className="space-y-4">
          <h2 className="text-[15px] font-medium text-ink">Vaihda sähköposti</h2>
          {profile.pendingEmail && (
            <p className="text-[13px] text-ink-2">
              Odottaa vahvistusta: {profile.pendingEmail}. Nykyinen osoite toimii siihen asti.
            </p>
          )}
          <Field label="Uusi sähköposti" htmlFor="newEmail">
            <input
              id="newEmail"
              type="email"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className={controlClass}
            />
          </Field>
          <Field label="Nykyinen salasana" htmlFor="emailPassword">
            <input
              id="emailPassword"
              type="password"
              autoComplete="current-password"
              required
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              className={controlClass}
            />
          </Field>
          {emailMsg && (
            <p className="text-sm text-ink-2" role="status">
              {emailMsg}
            </p>
          )}
          <Button type="submit" busy={emailBusy} busyLabel="Lähetetään…" className="w-full">
            Lähetä vahvistus
          </Button>
        </Card>
      </form>
    </div>
  );
}
