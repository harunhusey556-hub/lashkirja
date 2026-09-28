"use client";

import { useState } from "react";
import { apiFetch, errorMessage, readJson } from "@/components/clientFetch";
import { Card, PageTitle } from "@/components/ds";
import { Button, Field } from "@/components/ui";
import { controlClass } from "@/components/control-styles";

export default function SalasanaPage() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordMsg, setPasswordMsg] = useState("");
  const [passwordBusy, setPasswordBusy] = useState(false);

  async function changePassword(event: React.FormEvent) {
    event.preventDefault();
    setPasswordBusy(true);
    setPasswordMsg("");
    try {
      const response = await apiFetch("/api/auth/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      await readJson(response, "Salasanan vaihto epäonnistui");
      setCurrentPassword("");
      setNewPassword("");
      setPasswordMsg("Salasana vaihdettu. Muut laitteet kirjattiin ulos.");
    } catch (error: unknown) {
      setPasswordMsg(errorMessage(error, "Salasanan vaihto epäonnistui"));
    } finally {
      setPasswordBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageTitle title="Vaihda salasana" />
      <form onSubmit={(event) => void changePassword(event)}>
        <Card className="space-y-4">
          <p className="text-[13px] text-ink-2 leading-relaxed">
            Nykyinen salasana vaaditaan. Uudessa on vähintään 10 merkkiä. Muut kirjautuneet laitteet suljetaan.
          </p>
          <Field label="Nykyinen salasana" htmlFor="currentPassword">
            <input
              id="currentPassword"
              type="password"
              autoComplete="current-password"
              required
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              className={controlClass}
            />
          </Field>
          <Field label="Uusi salasana" htmlFor="newPassword">
            <input
              id="newPassword"
              type="password"
              autoComplete="new-password"
              required
              minLength={10}
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              className={controlClass}
            />
          </Field>
          {passwordMsg && (
            <p className="text-sm text-ink-2" role="status">
              {passwordMsg}
            </p>
          )}
          <Button type="submit" className="w-full" busy={passwordBusy} busyLabel="Vaihdetaan…">
            Vaihda salasana
          </Button>
        </Card>
      </form>
    </div>
  );
}
