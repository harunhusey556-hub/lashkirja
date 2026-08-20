"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

const ERROR_MESSAGES: Record<string, string> = {
  auth: "Väärä sähköposti tai salasana",
  missing: "Sähköposti ja salasana vaaditaan",
  server: "Kirjautuminen epäonnistui",
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

  return (
    // fixed + overflow-hidden + touch-none: login never scrolls or rubber-bands;
    // iOS pans the visual viewport itself when the keyboard covers an input.
    <div className="fixed inset-0 overflow-hidden touch-none flex items-center justify-center bg-cream px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-light text-charcoal tracking-wide">
            Tilikirja
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
          <div>
            <label
              htmlFor="email"
              className="block text-sm font-medium text-charcoal-light mb-1.5"
            >
              Sähköposti
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="username"
              className="w-full px-4 py-3 rounded-xl border border-warm-gray-light bg-cream/50 text-charcoal placeholder:text-warm-gray text-sm"
              placeholder="demo@lashkirja.fi"
              required
            />
          </div>

          <div>
            <label
              htmlFor="password"
              className="block text-sm font-medium text-charcoal-light mb-1.5"
            >
              Salasana
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              className="w-full px-4 py-3 rounded-xl border border-warm-gray-light bg-cream/50 text-charcoal placeholder:text-warm-gray text-sm"
              placeholder="••••••"
              required
            />
          </div>

          {error && (
            <p className="text-danger text-sm text-center">{error}</p>
          )}

          <button
            type="submit"
            className="w-full py-3 rounded-xl bg-accent text-white font-medium text-sm hover:bg-accent-dark transition-colors flex items-center justify-center gap-2"
          >
            {submitting && (
              <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
            )}
            {submitting ? "Kirjaudutaan…" : "Kirjaudu sisään"}
          </button>
        </form>

        <p className="text-center text-xs text-warm-gray mt-6">
          Demo: demo@lashkirja.fi / demo123
        </p>
      </div>
    </div>
  );
}
