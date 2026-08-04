"use client";

import { useSearchParams } from "next/navigation";

const ERROR_MESSAGES: Record<string, string> = {
  auth: "Väärä sähköposti tai salasana",
  missing: "Sähköposti ja salasana vaaditaan",
  server: "Kirjautuminen epäonnistui",
};

export default function LoginForm() {
  const searchParams = useSearchParams();
  const errorCode = searchParams.get("error");
  const error =
    (errorCode && ERROR_MESSAGES[errorCode]) ||
    (errorCode ? "Kirjautuminen epäonnistui" : "");

  return (
    <div className="min-h-screen flex items-center justify-center bg-cream px-4">
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
          className="bg-white rounded-2xl shadow-sm p-8 space-y-5"
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
            className="w-full py-3 rounded-xl bg-accent text-white font-medium text-sm hover:bg-accent-dark transition-colors"
          >
            Kirjaudu sisään
          </button>
        </form>

        <p className="text-center text-xs text-warm-gray mt-6">
          Demo: demo@lashkirja.fi / demo123
        </p>
      </div>
    </div>
  );
}
