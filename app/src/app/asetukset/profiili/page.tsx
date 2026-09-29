"use client";

import { useState } from "react";
import { ApiError, apiFetch, errorMessage, isUserFacingMessage, readJson } from "@/components/clientFetch";
import { type Profile, SaveStatus, useProfile } from "../useProfile";
import { ProfileGate } from "../ProfileGate";
import { Card, PageTitle } from "@/components/ds";
import { PasswordField } from "@/components/ds/PasswordField";
import { Button, Field, FormError, SavePhaseNote } from "@/components/ui";
import { controlClass } from "@/components/control-styles";
import { useEditorSession } from "@/components/form-session";
import { hapticNotify } from "@/lib/haptics";
import { showToast } from "@/lib/toast";

export default function ProfiiliPage() {
  const { profile, saving, savedMsg, loadError, retry, save } = useProfile();

  return (
    <ProfileGate
      profile={profile}
      loadError={loadError}
      retry={retry}
      title="Profiili"
      skeletonLabel="Ladataan profiilia"
      fields={2}
    >
      {(loaded) => (
        <>
          <PageTitle title="Profiili" />
          <ProfileForm profile={loaded} saving={saving} savedMsg={savedMsg} save={save} />
        </>
      )}
    </ProfileGate>
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
  const [emailError, setEmailError] = useState<{ email?: string; password?: string; form?: string }>({});
  const [emailBusy, setEmailBusy] = useState(false);

  // AUTH-13: leaving with unsaved name edits asks first (Back, tabs).
  const { dirty } = useEditorSession({
    sourceId: "settings-profile",
    draftKey: null,
    baseline: { firstName: profile.firstName, lastName: profile.lastName },
    value: { firstName, lastName },
    onRestore: () => {},
  });

  async function sendEmailChange(event: React.FormEvent) {
    event.preventDefault();
    if (emailBusy) return;
    const next: typeof emailError = {};
    if (!email.trim()) next.email = "Kirjoita uusi sähköpostiosoite.";
    if (!currentPassword) next.password = "Kirjoita nykyinen salasana.";
    setEmailError(next);
    if (next.email || next.password) {
      void hapticNotify("error");
      document.getElementById(next.email ? "newEmail" : "emailPassword")?.focus();
      return;
    }
    setEmailBusy(true);
    try {
      const response = await apiFetch("/api/auth/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), currentPassword }),
      });
      const data = await readJson<{ message: string }>(response, "Sähköpostin vaihto epäonnistui");
      setCurrentPassword("");
      showToast({
        tone: "success",
        text:
          data.message && isUserFacingMessage(data.message)
            ? data.message
            : "Vahvistuslinkki lähetettiin uuteen osoitteeseen.",
        durationMs: 6000,
      });
    } catch (error: unknown) {
      void hapticNotify("error");
      const message = errorMessage(error, "Sähköpostin vaihto epäonnistui");
      // A wrong current password answers 401 with its own message.
      const wrongPassword = error instanceof ApiError && error.status === 401;
      setEmailError(wrongPassword ? { password: message } : { form: message });
      if (wrongPassword) document.getElementById("emailPassword")?.focus();
    } finally {
      setEmailBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <Card className="flex items-center gap-4">
        <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xl font-semibold text-accent">
          {(profile.firstName?.[0] || "?").toUpperCase()}
        </span>
        <div className="min-w-0">
          <p className="clamp-lines [overflow-wrap:anywhere] text-body font-medium text-ink">
            {profile.firstName} {profile.lastName}
          </p>
          <p className="clamp-lines [overflow-wrap:anywhere] text-caption text-ink-2">{profile.email}</p>
        </div>
      </Card>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save({ firstName: firstName.trim(), lastName: lastName.trim() });
        }}
      >
        <Card className="space-y-4">
          <div className="field-grid">
            <Field label="Etunimi" htmlFor="firstName">
              <input
                id="firstName"
                name="firstName"
                type="text"
                autoComplete="given-name"
                autoCapitalize="words"
                enterKeyHint="next"
                required
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                className={controlClass}
              />
            </Field>
            <Field label="Sukunimi" htmlFor="lastName">
              <input
                id="lastName"
                name="lastName"
                type="text"
                autoComplete="family-name"
                autoCapitalize="words"
                enterKeyHint="done"
                required
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                className={controlClass}
              />
            </Field>
          </div>
          <p className="text-caption text-ink-2">
            Kirjautumissähköposti on {profile.email}. Uusi osoite otetaan käyttöön vasta vahvistuslinkin jälkeen.
          </p>

          <SaveStatus saving={saving} savedMsg={savedMsg} />
          {dirty && !saving && !savedMsg && <SavePhaseNote phase="dirty" />}
          <Button type="submit" busy={saving} busyLabel="Tallennetaan…" disabled={!dirty} className="w-full">
            Tallenna
          </Button>
        </Card>
      </form>

      <form onSubmit={(event) => void sendEmailChange(event)} noValidate>
        <Card className="space-y-4">
          <h2 className="text-body font-medium text-ink">Vaihda sähköposti</h2>
          {profile.pendingEmail && (
            <p className="text-caption text-ink-2">
              Odottaa vahvistusta: {profile.pendingEmail}. Nykyinen osoite toimii siihen asti.
            </p>
          )}
          {/* Lets iOS Password AutoFill pair the password below with this account (AUTH-10). */}
          <input
            type="text"
            name="username"
            autoComplete="username"
            value={profile.email}
            readOnly
            tabIndex={-1}
            aria-hidden
            className="sr-only"
          />
          <Field label="Uusi sähköposti" htmlFor="newEmail" error={emailError.email}>
            <input
              id="newEmail"
              name="newEmail"
              type="email"
              inputMode="email"
              autoComplete="email"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="next"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className={`${controlClass}${emailError.email ? " !border-danger" : ""}`}
            />
          </Field>
          <PasswordField
            id="emailPassword"
            name="emailPassword"
            label="Nykyinen salasana"
            autoComplete="current-password"
            enterKeyHint="go"
            required
            value={currentPassword}
            error={emailError.password}
            onChange={(event) => setCurrentPassword(event.target.value)}
          />
          <FormError message={emailError.form ?? ""} />
          <Button type="submit" busy={emailBusy} busyLabel="Lähetetään…" className="w-full">
            Lähetä vahvistus
          </Button>
        </Card>
      </form>
    </div>
  );
}
