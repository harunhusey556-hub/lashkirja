"use client";

import { useState } from "react";
import Link from "next/link";
import { controlClass } from "@/components/control-styles";
import { Button } from "@/components/ui";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/auth/password/forgot", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ email }),
      });
      const body = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
      if (!response.ok) {
        setError(body?.error || "Pyyntö epäonnistui");
        return;
      }
      setMessage(body?.message || "Jos tilille voidaan lähettää postia, palautuslinkki on matkalla.");
    } catch {
      setError("Pyyntö epäonnistui. Yritä uudelleen.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 flex items-center justify-center overflow-hidden bg-canvas px-4">
      <form
        onSubmit={(event) => void submit(event)}
        className="w-full max-w-sm space-y-5 rounded-card border border-line bg-surface p-8"
      >
        <h1 className="text-[32px] font-bold leading-tight tracking-[-0.02em] text-ink">Salasanan palautus</h1>
        <p className="text-[15px] text-ink-2">
          Linkki lähtee, jos tilille on yhdistetty lähetysposti. Muuten tuki voi lähettää linkin.
          Ohje: sovelluksen account-recovery-dokumentti.
        </p>
        <label htmlFor="email" className="mb-1.5 block text-[13px] text-ink-2">
          Sähköposti
        </label>
        <input
          id="email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className={controlClass}
        />
        {message && <p className="text-sm text-ink" role="status">{message}</p>}
        {error && <p className="text-sm text-danger" role="alert">{error}</p>}
        <Button type="submit" busy={busy} busyLabel="Lähetetään…" className="w-full">
          Lähetä linkki
        </Button>
        <Link href="/login" className="block text-center text-sm text-accent">
          Takaisin kirjautumiseen
        </Link>
      </form>
    </div>
  );
}
