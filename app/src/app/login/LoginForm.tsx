"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Button, Field, FormError } from "@/components/ui";

const ERROR_MESSAGES: Record<string, string> = {
  auth: "Väärä sähköposti tai salasana",
  missing: "Sähköposti ja salasana vaaditaan",
  server: "Kirjautuminen epäonnistui",
  rate: "Liian monta kirjautumisyritystä. Yritä muutaman minuutin kuluttua uudelleen.",
  expired: "Istuntosi vanhentui. Kirjaudu sisään uudelleen.",
};

export default function LoginForm() {
  const [submitting, setSubmitting] = useState(false);

  // iOS bfcache: swiping back to the login page restores the old React state,
  // which would leave the button stuck on the spinner — reset it on pageshow.
  useEffect(() => {
    const reset = () => setSubmitting(false);
    window.addEventListener("pageshow", reset);
    return () => window.removeEventListener("pageshow", reset);
  }, []);

  const searchParams = useSearchParams();
  const errorCode = searchParams.get("error");
  const error =
    (errorCode && ERROR_MESSAGES[errorCode]) ||
    (errorCode ? "Kirjautuminen epäonnistui" : "");
  // Deep-link continue-after-login: the server already validated this is an
  // internal path when it built the /login?next= redirect; carried through
  // as a hidden field so the login POST can send it straight back.
  const next = searchParams.get("next") || "";

  return (
    // fixed + overflow-hidden + touch-none: login never scrolls or rubber-bands;
    // iOS pans the visual viewport itself when the keyboard covers an input.
    <div className="fixed inset-0 overflow-hidden touch-none flex items-center justify-center bg-cream px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-light text-charcoal tracking-wide">
            LashKirja
          </h1>
          <p className="text-warm-gray mt-2 text-sm">
            Kirjanpito yksinkertaisesti
          </p>
        </div>

        {/* Native form POST — mobile browsers reliably store Set-Cookie on
            navigation responses; fetch()+redirect often drops the cookie. */}
        <form
          action="/api/auth/login"
          method="POST"
          // Native submit still runs; the state change only drives the
          // "Kirjaudutaan…" feedback while the browser navigates.
          onSubmit={() => setSubmitting(true)}
          className={`bg-white rounded-2xl shadow-sm p-8 space-y-5 transition-all duration-300 ${
            submitting ? "opacity-60 scale-[0.98] pointer-events-none" : ""
          }`}
        >
          {next && <input type="hidden" name="next" value={next} />}

          <Field label="Sähköposti" htmlFor="email">
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="w-full px-4 py-3 rounded-xl border border-warm-gray-light bg-cream/50 text-charcoal placeholder:text-warm-gray text-sm"
              placeholder="demo@lashkirja.fi"
              required
            />
          </Field>

          <Field label="Salasana" htmlFor="password">
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              className="w-full px-4 py-3 rounded-xl border border-warm-gray-light bg-cream/50 text-charcoal placeholder:text-warm-gray text-sm"
              placeholder="••••••"
              required
            />
          </Field>

          <FormError message={error} className="text-center" />

          <Button
            type="submit"
            busy={submitting}
            busyLabel="Kirjaudutaan…"
            allowBusySubmit
            className="w-full"
          >
            Kirjaudu sisään
          </Button>
        </form>

        <p className="text-center text-xs text-warm-gray mt-6">
          Demo: demo@lashkirja.fi / demo123
        </p>
      </div>
    </div>
  );
}
