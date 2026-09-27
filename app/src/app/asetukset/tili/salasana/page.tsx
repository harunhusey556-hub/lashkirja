"use client";

import { useState } from "react";
import { apiFetch, errorMessage, readJson } from "@/components/clientFetch";
import { Button, controlClass } from "@/components/ui";

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
    <form onSubmit={(event) => void changePassword(event)} className="bg-white rounded-2xl p-6 shadow-sm space-y-4">
      <h2 className="text-sm font-medium text-charcoal">Vaihda salasana</h2>
      <p className="text-sm text-warm-gray">
        Nykyinen salasana vaaditaan. Uudessa on vähintään 10 merkkiä. Muut kirjautuneet laitteet suljetaan.
      </p>
      <label htmlFor="currentPassword" className="block text-sm font-medium text-charcoal">
        Nykyinen salasana
      </label>
      <input
        id="currentPassword"
        type="password"
        autoComplete="current-password"
        required
        value={currentPassword}
        onChange={(event) => setCurrentPassword(event.target.value)}
        className={`${controlClass} min-h-12`}
      />
      <label htmlFor="newPassword" className="block text-sm font-medium text-charcoal">
        Uusi salasana
      </label>
      <input
        id="newPassword"
        type="password"
        autoComplete="new-password"
        required
        minLength={10}
        value={newPassword}
        onChange={(event) => setNewPassword(event.target.value)}
        className={`${controlClass} min-h-12`}
      />
      {passwordMsg && (
        <p className="text-sm text-warm-gray" role="status">
          {passwordMsg}
        </p>
      )}
      <Button type="submit" busy={passwordBusy} busyLabel="Vaihdetaan…" className="ml-auto">
        Vaihda salasana
      </Button>
    </form>
  );
}
