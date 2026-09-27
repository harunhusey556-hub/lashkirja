"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui";

function ResetForm() {
  const token = useSearchParams().get("token") || "";
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/password/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        setError(body?.error || "Salasanan vaihto epäonnistui");
        return;
      }
      setMessage("Salasana vaihdettu. Voit kirjautua sisään.");
    } catch {
      setError("Salasanan vaihto epäonnistui");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="w-full max-w-sm bg-white rounded-2xl shadow-sm p-8 space-y-5">
      <h1 className="text-2xl font-light text-charcoal">Uusi salasana</h1>
      <label htmlFor="password" className="block text-sm font-medium text-charcoal">
        Uusi salasana
      </label>
      <input
        id="password"
        type="password"
        autoComplete="new-password"
        required
        minLength={10}
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        className="w-full min-h-12 px-4 rounded-xl border border-warm-gray-light bg-cream/50 text-charcoal"
      />
      {message && <p className="text-sm text-charcoal" role="status">{message}</p>}
      {error && <p className="text-sm text-danger" role="alert">{error}</p>}
      <Button type="submit" busy={busy} busyLabel="Tallennetaan…" className="w-full" disabled={!token}>
        Tallenna salasana
      </Button>
      <Link href="/login" className="block text-center text-sm text-accent-dark">
        Kirjaudu sisään
      </Link>
    </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <div className="fixed inset-0 overflow-hidden flex items-center justify-center bg-cream px-4">
      <Suspense fallback={<p className="text-sm text-warm-gray">Ladataan…</p>}>
        <ResetForm />
      </Suspense>
    </div>
  );
}
