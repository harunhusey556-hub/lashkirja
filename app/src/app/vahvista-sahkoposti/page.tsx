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
    <form
      onSubmit={(event) => void submit(event)}
      className="w-full max-w-sm space-y-5 rounded-card border border-line bg-surface p-8"
    >
      <h1 className="text-[32px] font-bold leading-tight tracking-[-0.02em] text-ink">Vahvista sähköposti</h1>
      <p className="text-[15px] text-ink-2">
        Vahvistus vaihtaa kirjautumissähköpostin. Vanha osoite toimii, kunnes painat nappia.
      </p>
      {message && (
        <>
          <p className="text-sm text-ink" role="status">{message}</p>
          {typeof navigator !== "undefined" && /iPhone|iPad/.test(navigator.userAgent) && (
            <a href="lashkirja://open" className="block text-center text-sm text-accent">
              Avaa LashKirja-sovellus
            </a>
          )}
        </>
      )}
      {error && <p className="text-sm text-danger" role="alert">{error}</p>}
      <Button type="submit" busy={busy} busyLabel="Vahvistetaan…" className="w-full" disabled={!token}>
        Vahvista
      </Button>
      <Link href="/asetukset/profiili" className="block text-center text-sm text-accent">
        Profiiliin
      </Link>
    </form>
  );
}

export default function ConfirmEmailPage() {
  return (
    <div className="fixed inset-0 flex items-center justify-center overflow-hidden bg-canvas px-4">
      <Suspense fallback={<p className="text-sm text-ink-2">Ladataan…</p>}>
        <ConfirmForm />
      </Suspense>
    </div>
  );
}
