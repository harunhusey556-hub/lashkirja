"use client";

import { useState } from "react";
import Link from "next/link";
import { MailCheck } from "lucide-react";
import { BARE_CARD_CLASS, BARE_LINK_CLASS, BareFrame } from "@/components/BareFrame";
import { apiFetch, errorMessage, isUserFacingMessage, readJson } from "@/components/clientFetch";
import { controlClass } from "@/components/control-styles";
import { Icon } from "@/components/ds/Icon";
import { Button, Field } from "@/components/ui";
import { hapticNotify } from "@/lib/haptics";

const SENT_COPY = "Jos osoitteella löytyy tili, palautuslinkki on matkalla. Tarkista myös roskaposti.";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState("");
  const [sentMessage, setSentMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    const address = email.trim();
    if (!address) {
      setError("Kirjoita sähköpostiosoite.");
      document.getElementById("email")?.focus();
      return;
    }
    setBusy(true);
    setError("");
    try {
      // apiFetch, not a bare fetch: in the bundled app "/api/..." would hit
      // the static file server, which answers 200 with HTML (AUTH-02).
      const response = await apiFetch("/api/auth/password/forgot", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ email: address }),
      });
      // readJson refuses an empty or non-JSON body, so a 200 that is not the
      // API's answer counts as a failure too.
      const body = await readJson<{ message?: string }>(response, "Pyyntö epäonnistui");
      void hapticNotify("success");
      setSentTo(address);
      setSentMessage(body.message && isUserFacingMessage(body.message) ? body.message : SENT_COPY);
    } catch (caught: unknown) {
      void hapticNotify("error");
      setError(errorMessage(caught, "Pyyntö epäonnistui. Yritä uudelleen."));
    } finally {
      setBusy(false);
    }
  }

  if (sentTo) {
    return (
      <BareFrame>
        <div className={BARE_CARD_CLASS}>
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-accent-soft text-accent">
            <Icon icon={MailCheck} size="hero" />
          </span>
          <h1 className="text-[28px] font-bold leading-tight tracking-[-0.02em] text-ink">Tarkista sähköpostisi</h1>
          <p className="text-[15px] leading-relaxed text-ink-2" role="status">
            {sentMessage} Linkki lähetettiin osoitteeseen {sentTo}.
          </p>
          <Button
            type="button"
            variant="secondary"
            className="w-full"
            onClick={() => {
              setSentTo("");
              setSentMessage("");
            }}
          >
            Lähetä uudelleen
          </Button>
          <Link href="/login" className={BARE_LINK_CLASS}>
            Takaisin kirjautumiseen
          </Link>
        </div>
      </BareFrame>
    );
  }

  return (
    <BareFrame>
      <form onSubmit={(event) => void submit(event)} noValidate className={BARE_CARD_CLASS}>
        <h1 className="text-[28px] font-bold leading-tight tracking-[-0.02em] text-ink">Salasanan palautus</h1>
        <p className="text-[15px] leading-relaxed text-ink-2">
          Kirjoita tilisi sähköpostiosoite. Jos tili löytyy, saat postiin linkin, jolla valitset uuden salasanan.
          Jos viestiä ei tule, ota yhteyttä tukeen.
        </p>
        <Field label="Sähköposti" htmlFor="email" error={error}>
          <input
            id="email"
            name="email"
            type="email"
            inputMode="email"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className={`${controlClass}${error ? " !border-danger" : ""}`}
          />
        </Field>
        <Button type="submit" busy={busy} busyLabel="Lähetetään…" className="w-full">
          Lähetä linkki
        </Button>
        <Link href="/login" className={BARE_LINK_CLASS}>
          Takaisin kirjautumiseen
        </Link>
      </form>
    </BareFrame>
  );
}
