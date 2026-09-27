"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui";

function ConfirmForm() {
  const token = useSearchParams().get("token") || "";
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/email/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ token }),
      });
      const body = (await response.json().catch(() => null)) as { error?: string; email?: string } | null;
      if (!response.ok) {
        setError(body?.error || "Vahvistus epäonnistui");
        return;
      }
      setMessage(`Sähköposti vaihdettu${body?.email ? `: ${body.email}` : ""}.`);
    } catch {
      setError("Vahvistus epäonnistui");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="w-full max-w-sm bg-white rounded-2xl shadow-sm p-8 space-y-5">
      <h1 className="text-2xl font-light text-charcoal">Vahvista sähköposti</h1>
      <p className="text-sm text-warm-gray">
        Vahvistus vaihtaa kirjautumissähköpostin. Vanha osoite toimii, kunnes painat nappia.
      </p>
      {message && <p className="text-sm text-charcoal" role="status">{message}</p>}
      {error && <p className="text-sm text-danger" role="alert">{error}</p>}
      <Button type="submit" busy={busy} busyLabel="Vahvistetaan…" className="w-full" disabled={!token}>
        Vahvista
      </Button>
      <Link href="/asetukset/profiili" className="block text-center text-sm text-accent-dark">
        Profiiliin
      </Link>
    </form>
  );
}

export default function ConfirmEmailPage() {
  return (
    <div className="fixed inset-0 overflow-hidden flex items-center justify-center bg-cream px-4">
      <Suspense fallback={<p className="text-sm text-warm-gray">Ladataan…</p>}>
        <ConfirmForm />
      </Suspense>
    </div>
  );
}
