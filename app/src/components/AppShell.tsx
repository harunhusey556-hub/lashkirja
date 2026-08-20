"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { ErrorState, LoadingState } from "@/components/AsyncState";
import { OnboardingModal } from "@/components/OnboardingModal";
import { AiChatDrawer } from "@/components/AiChatDrawer";
import {
  errorMessage,
  isUnauthorized,
  readJson,
  redirectToLogin,
} from "@/components/clientFetch";

const NAV_ITEMS = [
  {
    href: "/dashboard",
    label: "Etusivu",
    icon: (active: boolean) => (
      <svg
        className={`w-6 h-6 ${active ? "text-accent" : "text-warm-gray"}`}
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        aria-hidden
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.75}
          d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1v-9.5Z"
        />
      </svg>
    ),
  },
  {
    href: "/kuitit",
    label: "Kuitit",
    icon: (active: boolean) => (
      <svg
        className={`w-6 h-6 ${active ? "text-accent" : "text-warm-gray"}`}
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        aria-hidden
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.75}
          d="M9 12h6m-6 4h6m2 5H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5.586a1 1 0 0 1 .707.293l5.414 5.414a1 1 0 0 1 .293.707V19a2 2 0 0 1-2 2Z"
        />
      </svg>
    ),
  },
  {
    href: "/tiliotteet",
    label: "Tiliote",
    icon: (active: boolean) => (
      <svg
        className={`w-6 h-6 ${active ? "text-accent" : "text-warm-gray"}`}
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        aria-hidden
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.75}
          d="M3 6h18M3 12h18M3 18h10"
        />
      </svg>
    ),
  },
  {
    href: "/pankkitilit",
    label: "Pankki",
    icon: (active: boolean) => (
      <svg
        className={`w-6 h-6 ${active ? "text-accent" : "text-warm-gray"}`}
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        aria-hidden
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.75}
          d="M3 10h18M5 10V8.5L12 4l7 4.5V10M6 10v7m4-7v7m4-7v7m4-7v7M4 20h16"
        />
      </svg>
    ),
  },
] as const;

const MORE_ITEMS = [
  { href: "/laskut", label: "Myyntilaskut", hint: "Laskutus, viitenumerot, saatavat" },
  { href: "/asiakkaat", label: "Asiakkaat", hint: "Asiakasrekisteri ja avoimet saatavat" },
  { href: "/raportit", label: "Raportit", hint: "Tuloslaskelma ja CSV-viennit" },
  { href: "/alv-raportti", label: "ALV-raportti", hint: "Arvonlisäveron yhteenveto" },
  { href: "/asetukset", label: "Asetukset", hint: "Profiili, sähköposti, kirjautuminen" },
] as const;

function navActive(pathname: string, href: string): boolean {
  if (href === "/dashboard") return pathname === "/dashboard";
  return pathname === href || pathname.startsWith(`${href}/`);
}

function pageTitle(pathname: string): string {
  if (pathname.startsWith("/kuitit")) return "Kuitit & laskut";
  if (pathname.startsWith("/pankkitilit")) return "Pankkitilit";
  if (/^\/laskut\/[^/]+$/.test(pathname)) return "Lasku";
  if (pathname.startsWith("/laskut")) return "Myyntilaskut";
  if (pathname.startsWith("/asiakkaat")) return "Asiakkaat";
  if (pathname.startsWith("/raportit")) return "Raportit";
  if (/^\/tiliotteet\/[^/]+$/.test(pathname)) return "Tiliote";
  if (pathname.startsWith("/tiliotteet")) return "Tiliotteet";
  if (pathname.startsWith("/alv-raportti")) return "ALV-raportti";
  if (pathname.startsWith("/asetukset")) return "Asetukset";
  return "Etusivu";
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const [authAttempt, setAuthAttempt] = useState(0);
  const [authState, setAuthState] = useState<
    { status: "checking" | "ready" | "error"; message?: string }
  >({ status: "checking" });
  const [showOnboarding, setShowOnboarding] = useState(false);
  // Stored with the path it was opened on, so a route change closes it without
  // an effect that would re-render twice.
  const [moreOpenOn, setMoreOpenOn] = useState<string | null>(null);
  const [onboardingProfile, setOnboardingProfile] = useState<any>(null);

  const pathname = usePathname();
  const title = pageTitle(pathname);

  useEffect(() => {
    const controller = new AbortController();

    fetch("/api/auth/me", {
      credentials: "include",
      signal: controller.signal,
    })
      .then((response) =>
        readJson<{ user: { userId: string } }>(
          response,
          "Istunnon tarkistus epäonnistui"
        )
      )
      .then(() => {
        setAuthState({ status: "ready" });
        // Check onboarding state
        return fetch("/api/onboarding", { signal: controller.signal })
          .then((res) => readJson<{ onboarded: boolean; profile: any }>(res, ""))
          .then((data) => {
            if (data && !data.onboarded) {
              setOnboardingProfile(data.profile || null);
              setShowOnboarding(true);
            }
          })
          .catch(() => {});
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (isUnauthorized(error)) {
          redirectToLogin();
          return;
        }
        setAuthState({
          status: "error",
          message: errorMessage(error, "Istunnon tarkistus epäonnistui"),
        });
      });

    return () => controller.abort();
  }, [authAttempt]);

  function retryAuth() {
    setAuthState({ status: "checking" });
    setAuthAttempt((attempt) => attempt + 1);
  }

  const moreActive = MORE_ITEMS.some((item) => navActive(pathname, item.href));
  const showMore = moreOpenOn === pathname;

  return (
    <div className="min-h-dvh flex flex-col bg-cream">
      <header className="app-header sticky top-0 z-40 bg-white/90 backdrop-blur-md border-b border-warm-gray-light/30">
        <div className="max-w-lg mx-auto flex items-center justify-center px-4 h-12">
          <p className="text-base font-medium text-charcoal truncate">{title}</p>
        </div>
      </header>

      <main className="app-main flex-1 max-w-lg mx-auto w-full px-4 pt-4">
        {authState.status === "checking" ? (
          <LoadingState label="Tarkistetaan istuntoa..." />
        ) : authState.status === "error" ? (
          <ErrorState
            message={authState.message || "Istunnon tarkistus epäonnistui"}
            onRetry={retryAuth}
          />
        ) : (
          children
        )}
      </main>

      {authState.status === "ready" && (
        <>
          <AiChatDrawer />
          <OnboardingModal
            isOpen={showOnboarding}
            initialProfile={onboardingProfile}
            onComplete={() => setShowOnboarding(false)}
          />

          <nav
            className="app-tab-bar fixed bottom-0 inset-x-0 z-50 bg-white/95 backdrop-blur-md border-t border-warm-gray-light/40"
            aria-label="Päävalikko"
          >
            <div className="max-w-lg mx-auto h-[var(--app-tab-height)] flex items-stretch">
              {NAV_ITEMS.map((item) => {
                const active = navActive(pathname, item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`flex flex-1 flex-col items-center justify-center gap-0.5 touch-target active:bg-blush/30 transition-colors ${
                      active ? "text-accent-dark" : "text-warm-gray"
                    }`}
                    aria-current={active ? "page" : undefined}
                  >
                    {item.icon(active)}
                    <span
                      className={`text-[10px] leading-none ${active ? "font-semibold" : "font-medium"}`}
                    >
                      {item.label}
                    </span>
                  </Link>
                );
              })}

              <button
                type="button"
                onClick={() => setMoreOpenOn((open) => (open === pathname ? null : pathname))}
                aria-expanded={showMore}
                aria-haspopup="menu"
                className={`flex flex-1 flex-col items-center justify-center gap-0.5 touch-target active:bg-blush/30 transition-colors ${
                  moreActive || showMore ? "text-accent-dark" : "text-warm-gray"
                }`}
              >
                <svg
                  className={`w-6 h-6 ${moreActive || showMore ? "text-accent" : "text-warm-gray"}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.75}
                    d="M5 12h.01M12 12h.01M19 12h.01"
                  />
                </svg>
                <span className={`text-[10px] leading-none ${moreActive || showMore ? "font-semibold" : "font-medium"}`}>
                  Lisää
                </span>
              </button>
            </div>
          </nav>

          {showMore && (
            <>
              <div
                className="fixed inset-0 z-40 bg-charcoal/20"
                onClick={() => setMoreOpenOn(null)}
                aria-hidden
              />
              <div
                role="menu"
                aria-label="Lisää-valikko"
                className="fixed inset-x-0 z-50 bottom-[var(--app-tab-height)] max-w-lg mx-auto bg-white border-t border-warm-gray-light/40 rounded-t-3xl p-4 space-y-1 shadow-lg"
              >
                {MORE_ITEMS.map((item) => {
                  const active = navActive(pathname, item.href);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      role="menuitem"
                      onClick={() => setMoreOpenOn(null)}
                      className={`block px-4 py-3 rounded-2xl active:bg-blush/40 ${
                        active ? "bg-blush/50" : ""
                      }`}
                    >
                      <span className="block text-sm font-medium text-charcoal">{item.label}</span>
                      <span className="block text-xs text-warm-gray">{item.hint}</span>
                    </Link>
                  );
                })}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

