"use client";

import { useState } from "react";
import { ApiError, apiFetch, errorMessage, readJson } from "@/components/clientFetch";
import { Card, PageTitle } from "@/components/ds";
import { PasswordField } from "@/components/ds/PasswordField";
import { useSession } from "@/components/SessionProvider";
import { Button, FormError } from "@/components/ui";
import { hapticNotify } from "@/lib/haptics";
import { PASSWORD_MIN as MIN_PASSWORD_LENGTH } from "@/lib/session-policy";
import { showToast } from "@/lib/toast";


type Errors = { current?: string; next?: string; repeat?: string; form?: string };

export default function SalasanaPage() {
  const { user } = useSession();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [repeatPassword, setRepeatPassword] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);

  async function changePassword(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    const next: Errors = {};
    if (!currentPassword) next.current = "Kirjoita nykyinen salasana.";
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      next.next = `Uudessa salasanassa on oltava vähintään ${MIN_PASSWORD_LENGTH} merkkiä.`;
    }
    if (repeatPassword !== newPassword) next.repeat = "Salasanat eivät täsmää.";
    setErrors(next);
    const firstInvalid = next.current ? "currentPassword" : next.next ? "newPassword" : next.repeat ? "repeatPassword" : null;
    if (firstInvalid) {
      void hapticNotify("error");
      document.getElementById(firstInvalid)?.focus();
      return;
    }

    setBusy(true);
    try {
      const response = await apiFetch("/api/auth/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      await readJson(response, "Salasanan vaihto epäonnistui");
      setCurrentPassword("");
      setNewPassword("");
      setRepeatPassword("");
      showToast({ tone: "success", text: "Salasana vaihdettu. Muut laitteet kirjattiin ulos." });
    } catch (error: unknown) {
      void hapticNotify("error");
      // A wrong current password comes back as 401 with its own message: it
      // belongs under that field, not in an "expired session" banner.
      if (error instanceof ApiError && error.status === 401) {
        setErrors({ current: errorMessage(error, "Nykyinen salasana on väärä.") });
        document.getElementById("currentPassword")?.focus();
      } else {
        setErrors({ form: errorMessage(error, "Salasanan vaihto epäonnistui") });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageTitle title="Vaihda salasana" />
      <form onSubmit={(event) => void changePassword(event)} noValidate>
        <Card className="space-y-4">
          <p className="text-[13px] text-ink-2 leading-relaxed">
            Nykyinen salasana vaaditaan. Uudessa on vähintään {MIN_PASSWORD_LENGTH} merkkiä. Muut kirjautuneet laitteet suljetaan.
          </p>
          {/* Lets iOS Password AutoFill pair the new password with this account (AUTH-10). */}
          <input
            type="text"
            name="username"
            autoComplete="username"
            value={user?.email ?? ""}
            readOnly
            tabIndex={-1}
            aria-hidden
            className="sr-only"
          />
          <PasswordField
            id="currentPassword"
            name="currentPassword"
            label="Nykyinen salasana"
            autoComplete="current-password"
            enterKeyHint="next"
            required
            value={currentPassword}
            error={errors.current}
            onChange={(event) => setCurrentPassword(event.target.value)}
          />
          <PasswordField
            id="newPassword"
            name="newPassword"
            label="Uusi salasana"
            autoComplete="new-password"
            enterKeyHint="next"
            required
            value={newPassword}
            error={errors.next}
            onChange={(event) => setNewPassword(event.target.value)}
          />
          <PasswordField
            id="repeatPassword"
            name="repeatPassword"
            label="Toista uusi salasana"
            autoComplete="new-password"
            enterKeyHint="go"
            required
            value={repeatPassword}
            error={errors.repeat}
            onChange={(event) => setRepeatPassword(event.target.value)}
          />
          <FormError message={errors.form ?? ""} />
          <Button type="submit" className="w-full" busy={busy} busyLabel="Vaihdetaan…">
            Vaihda salasana
          </Button>
        </Card>
      </form>
    </div>
  );
}
