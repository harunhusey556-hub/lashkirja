"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ErrorState, LoadingState } from "@/components/AsyncState";
import { OnboardingModal } from "@/components/OnboardingModal";
import { AiChatDrawer } from "@/components/AiChatDrawer";
import {
  errorMessage,
  isUnauthorized,
  readJson,
  redirectToLogin,
  signOut,
} from "@/components/clientFetch";

import type { BusinessProfile } from "@/lib/onboarding";
import BottomSheet from "@/components/BottomSheet";
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
  { href: "/toistuvat", label: "Toistuvat laskut", hint: "Automaattinen laskutus aikataulun mukaan" },
  { href: "/ostolaskut", label: "Ostolaskut", hint: "Mitä olet velkaa ja milloin" },
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
  if (pathname.startsWith("/ostolaskut")) return "Ostolaskut";
  if (pathname.startsWith("/toistuvat")) return "Toistuvat laskut";
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
  const [profileOpenOn, setProfileOpenOn] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [user, setUser] = useState<{ email?: string; firstName?: string } | null>(null);
  const [onboardingProfile, setOnboardingProfile] = useState<BusinessProfile | null>(null);

  const pathname = usePathname();
  const router = useRouter();
  const title = pageTitle(pathname);

  useEffect(() => {
    // The tab-bar links prefetch themselves; these live behind the sheet and
    // would otherwise be fetched only after the user has already tapped.
    for (const item of MORE_ITEMS) router.prefetch(item.href);
  }, [router]);

  useEffect(() => {
    const controller = new AbortController();

    fetch("/api/auth/me", {
      credentials: "include",
      signal: controller.signal,
    })
      .then((response) =>
        readJson<{ user: { userId: string; email?: string; firstName?: string } }>(
          response,
          "Istunnon tarkistus epäonnistui"
        )
      )
      .then((me) => {
        setUser(me.user ?? null);
        setAuthState({ status: "ready" });
        // Check onboarding state
        return fetch("/api/onboarding", { signal: controller.signal })
          .then((res) => readJson<{ onboarded: boolean; profile: BusinessProfile | null }>(res, ""))
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
  const showProfile = profileOpenOn === pathname;
  const initials = (user?.firstName?.trim()?.[0] || user?.email?.trim()?.[0] || "").toUpperCase();

  async function handleSignOut() {
    if (signingOut) return;
    setSigningOut(true);
    await signOut();
  }

  return (
    <div className="h-dvh overflow-hidden flex flex-col bg-cream">
      <header className="app-header sticky top-0 z-40 bg-white/90 backdrop-blur-md border-b border-warm-gray-light/30">
        <div className="max-w-lg mx-auto relative flex items-center justify-center px-4 h-12">
          <p className="text-base font-medium text-charcoal truncate max-w-[60%]">{title}</p>

          {authState.status === "ready" && (
            <button
              type="button"
              onClick={() => setProfileOpenOn((open) => (open === pathname ? null : pathname))}
              aria-label="Profiili ja uloskirjautuminen"
              aria-haspopup="dialog"
              className="absolute right-1 inset-y-0 my-auto w-11 h-11 flex items-center justify-center active-press"
            >
              <span className="w-8 h-8 rounded-full bg-blush text-accent-dark text-xs font-semibold flex items-center justify-center border border-blush-dark/40">
                {initials || (
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} aria-hidden>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8a7 7 0 0 1 14 0" />
                  </svg>
                )}
              </span>
            </button>
          )}
        </div>
      </header>

      <main
        // Keyed on the path so the enter animation replays on every navigation.
        key={pathname}
        className="app-main flex-1 max-w-lg mx-auto w-full px-4 pt-4 animate-page"
      >
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
            initialProfile={onboardingProfile ?? undefined}
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

          <BottomSheet
            isOpen={showMore}
            onClose={() => setMoreOpenOn(null)}
            title="Lisää"
            subtitle="Laskutus, raportit ja asetukset"
            labelledBy="more-sheet-title"
            heightClass="max-h-[70dvh]"
          >
            <nav
              aria-label="Lisää-valikko"
              className="overflow-y-auto px-3 py-2 sheet-safe-bottom"
            >
              {MORE_ITEMS.map((item) => {
                const active = navActive(pathname, item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setMoreOpenOn(null)}
                    aria-current={active ? "page" : undefined}
                    className={`flex items-center gap-3 px-4 py-3.5 rounded-2xl transition-colors active:bg-blush/40 ${
                      active ? "bg-blush/50" : ""
                    }`}
                  >
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm font-medium text-charcoal">
                        {item.label}
                      </span>
                      <span className="block text-xs text-warm-gray truncate">{item.hint}</span>
                    </span>
                    <svg
                      className="w-4 h-4 text-warm-gray-light shrink-0"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                      aria-hidden
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                    </svg>
                  </Link>
                );
              })}
            </nav>
          </BottomSheet>

          <BottomSheet
            isOpen={showProfile}
            onClose={() => setProfileOpenOn(null)}
            title={user?.firstName || "Profiili"}
            subtitle={user?.email}
            labelledBy="profile-sheet-title"
            heightClass="max-h-[60dvh]"
          >
            <div className="px-3 py-2 sheet-safe-bottom space-y-1">
              <Link
                href="/asetukset"
                onClick={() => setProfileOpenOn(null)}
                className="flex items-center gap-3 px-4 py-3.5 rounded-2xl transition-colors active:bg-blush/40"
              >
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-medium text-charcoal">Asetukset</span>
                  <span className="block text-xs text-warm-gray">Profiili, yritys, sähköpostit</span>
                </span>
                <svg
                  className="w-4 h-4 text-warm-gray-light shrink-0"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  aria-hidden
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                </svg>
              </Link>

              <button
                type="button"
                onClick={handleSignOut}
                disabled={signingOut}
                className="w-full flex items-center gap-3 px-4 py-3.5 rounded-2xl text-left transition-colors active:bg-danger/10 disabled:opacity-60 touch-target"
              >
                {signingOut ? (
                  <span
                    className="w-4 h-4 border-2 border-danger/40 border-t-danger rounded-full animate-spin motion-reduce:animate-none"
                    aria-hidden
                  />
                ) : (
                  <svg
                    className="w-4 h-4 text-danger shrink-0"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.75}
                    aria-hidden
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M15.75 9V5.25A2.25 2.25 0 0 0 13.5 3h-6a2.25 2.25 0 0 0-2.25 2.25v13.5A2.25 2.25 0 0 0 7.5 21h6a2.25 2.25 0 0 0 2.25-2.25V15m3 0 3-3m0 0-3-3m3 3H9"
                    />
                  </svg>
                )}
                <span className="text-sm font-medium text-danger">
                  {signingOut ? "Kirjaudutaan ulos…" : "Kirjaudu ulos"}
                </span>
              </button>
            </div>
          </BottomSheet>
        </>
      )}
    </div>
  );
}

