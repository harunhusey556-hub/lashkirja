"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
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
import { apiFetch } from "@/components/clientFetch";
import { readPageCache, writePageCache } from "@/lib/page-cache";
import {
  armNavigation,
  consumeDirection,
  markHistoryBack,
  type NavDirection,
} from "@/lib/nav-direction";
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

function routeDepth(pathname: string): number {
  return pathname.split("/").filter(Boolean).length;
}

/** Where the header back button lands when there is no history to pop. */
function parentPath(pathname: string): string {
  const segments = pathname.split("/").filter(Boolean);
  segments.pop();
  return segments.length > 0 ? `/${segments.join("/")}` : "/dashboard";
}

type ShellUser = { email?: string; firstName?: string };

/**
 * The session check lives in the page cache so the first paint after a full
 * load can skip the "checking session" state. The shell itself stays mounted
 * across navigations (see ShellGate), so this revalidation does not remount
 * the header, tab bar, or chat.
 */
const AUTH_CACHE_KEY = "shell-auth";
/** Set once the onboarding endpoint has confirmed the user is onboarded. */
const ONBOARDED_CACHE_KEY = "shell-onboarded";

let warmedTabs = false;

function currentMonthKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * Fire-and-forget warm-up of the main tab payloads right after the first
 * successful session check, so even the first tap on each tab paints with
 * data instead of a skeleton. Keys and shapes mirror what each page caches
 * for itself; existing entries are never overwritten.
 */
function warmTabCaches() {
  if (warmedTabs) return;
  warmedTabs = true;

  const warm = (url: string, key: string, pick: (data: Record<string, unknown>) => unknown) => {
    if (readPageCache(key) !== null) return;
    apiFetch(url, { credentials: "include" })
      .then((res) => (res.ok ? (res.json() as Promise<Record<string, unknown>>) : null))
      .then((data) => {
        if (!data) return;
        const value = pick(data);
        if (value !== undefined && readPageCache(key) === null) {
          writePageCache(key, value);
        }
      })
      .catch(() => {
        // Warm-up only; the page's own fetch will surface real errors.
      });
  };

  // Key must match the kuitit page's default query (its default sort is
  // part of the query string).
  warm("/api/receipts?sort=date_desc", "receipts:sort=date_desc", (d) => d.receipts ?? []);
  warm("/api/receipts?reviewStatus=pending", "receipts-pending", (d) => d.receipts ?? []);
  warm("/api/statements", "statements", (d) => d.statements ?? []);
  warm("/api/bank-accounts", "bank-overview", (d) => (d.accounts ? d : undefined));
  warm("/api/invoices?", "invoices", (d) => (d.invoices && d.aging ? d : undefined));
  const month = currentMonthKey();
  warm(`/api/dashboard?month=${month}`, `dashboard:${month}`, (d) =>
    Number.isFinite(d.income) && Number.isFinite(d.expenses) && d.vat ? d : undefined
  );
}

function navActive(pathname: string, href: string): boolean {
  if (href === "/dashboard") return pathname === "/dashboard";
  return pathname === href || pathname.startsWith(`${href}/`);
}

function pageTitle(pathname: string): string {
  if (pathname === "/kuitit/uusi") return "Uusi kuitti";
  if (/^\/kuitit\/[^/]+$/.test(pathname)) return "Kuitti";
  if (pathname.startsWith("/kuitit")) return "Kuitit ja laskut";
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
  if (pathname.startsWith("/asetukset/profiili")) return "Profiili";
  if (pathname.startsWith("/asetukset/yritys")) return "Yritysmuoto & ALV";
  if (pathname.startsWith("/asetukset/laskutus")) return "Laskuttajan tiedot";
  if (pathname.startsWith("/asetukset/kirjanpito")) return "Kirjanpidon lukitus";
  if (pathname.startsWith("/asetukset/sahkoposti")) return "Sähköpostien tuonti";
  if (pathname.startsWith("/asetukset")) return "Asetukset";
  return "Etusivu";
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const [authAttempt, setAuthAttempt] = useState(0);
  const [authState, setAuthState] = useState<
    { status: "checking" | "ready" | "error"; message?: string }
  >(() =>
    readPageCache<ShellUser>(AUTH_CACHE_KEY) ? { status: "ready" } : { status: "checking" }
  );
  const [showOnboarding, setShowOnboarding] = useState(false);
  // Stored with the path it was opened on, so a route change closes it without
  // an effect that would re-render twice.
  const [moreOpenOn, setMoreOpenOn] = useState<string | null>(null);
  const [profileOpenOn, setProfileOpenOn] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [user, setUser] = useState<ShellUser | null>(() => readPageCache<ShellUser>(AUTH_CACHE_KEY));
  const [onboardingProfile, setOnboardingProfile] = useState<BusinessProfile | null>(null);

  const pathname = usePathname();
  const router = useRouter();
  const title = pageTitle(pathname);
  const mainRef = useRef<HTMLElement>(null);
  const swipeLock = useRef(false);
  // Adjusting state during render is how a new pathname picks its enter
  // direction before paint. The server skips this so the first HTML matches
  // the client's first visit (direction "none" until a real navigation).
  const [navFrame, setNavFrame] = useState<{ path: string; direction: NavDirection }>({
    path: "",
    direction: "none",
  });
  if (typeof window !== "undefined" && navFrame.path !== pathname) {
    setNavFrame({ path: pathname, direction: consumeDirection(pathname) });
  }
  const direction = navFrame.path === pathname ? navFrame.direction : "none";
  const canGoBack = routeDepth(pathname) > 1;

  function goBack() {
    if (window.history.length > 1) {
      markHistoryBack();
      router.back();
    } else {
      const target = parentPath(pathname);
      armNavigation(target, "back");
      router.push(target);
    }
  }

  // Browser/OS back (popstate) plays the pop transition even when the route
  // depth does not change.
  useEffect(() => {
    const markPop = () => {
      markHistoryBack();
    };
    window.addEventListener("popstate", markPop);
    return () => window.removeEventListener("popstate", markPop);
  }, []);

  // iOS-style edge swipe back on drill-in pages. Starts only within 24px of
  // the left edge so horizontally scrollable content keeps working, tracks the
  // finger interruptibly, and never leaves a resting transform on <main>
  // (a retained transform re-anchors position:fixed descendants).
  useEffect(() => {
    if (!canGoBack) return;
    const main = mainRef.current;
    if (!main) return;

    const EDGE = 24;
    let startX = 0;
    let startY = 0;
    let startTime = 0;
    let dx = 0;
    let tracking = false;
    let decided = false;

    const clearInline = () => {
      main.style.transform = "";
      main.style.transition = "";
      main.style.opacity = "";
    };

    const onTouchStart = (event: TouchEvent) => {
      if (swipeLock.current) return;
      if (event.touches.length !== 1) return;
      const touch = event.touches[0];
      if (touch.clientX > EDGE) return;
      // Filter chip rows (laskut/ostolaskut/kuitit) sit close enough to the
      // left edge that a touch starting on them can land inside the 24px
      // zone; letting the edge-swipe win there would break their horizontal
      // scroll. Anything the page marks as horizontally scrollable is exempt.
      if (
        event.target instanceof Element &&
        event.target.closest(".overflow-x-auto")
      ) {
        return;
      }
      tracking = true;
      decided = false;
      dx = 0;
      startX = touch.clientX;
      startY = touch.clientY;
      startTime = performance.now();
    };

    const onTouchMove = (event: TouchEvent) => {
      if (!tracking) return;
      const touch = event.touches[0];
      const moveX = touch.clientX - startX;
      const moveY = touch.clientY - startY;
      if (!decided) {
        if (Math.abs(moveX) < 8 && Math.abs(moveY) < 8) return;
        if (Math.abs(moveY) > Math.abs(moveX) || moveX <= 0) {
          tracking = false;
          return;
        }
        decided = true;
        main.style.transition = "none";
      }
      event.preventDefault();
      dx = Math.max(0, moveX);
      main.style.transform = `translateX(${dx}px)`;
    };

    const onTouchEnd = () => {
      if (!tracking) return;
      tracking = false;
      if (!decided) return;
      const elapsed = Math.max(performance.now() - startTime, 1);
      const velocity = dx / elapsed;
      const commit =
        dx > window.innerWidth * 0.32 || (dx > 56 && velocity > 0.45);
      const reduceMotion = window.matchMedia(
        "(prefers-reduced-motion: reduce)"
      ).matches;

      if (commit) {
        swipeLock.current = true;
        const navigate = () => {
          if (window.history.length > 1) {
            markHistoryBack();
            router.back();
          } else {
            const target = parentPath(pathname);
            armNavigation(target, "back");
            router.push(target);
          }
        };
        if (reduceMotion) {
          clearInline();
          navigate();
          return;
        }
        main.style.transition = "transform 0.18s ease-out, opacity 0.18s ease-out";
        main.style.transform = "translateX(100%)";
        main.style.opacity = "0.4";
        window.setTimeout(navigate, 170);
      } else {
        main.style.transition =
          "transform 0.2s cubic-bezier(0.32, 0.72, 0, 1)";
        main.style.transform = "translateX(0)";
        window.setTimeout(clearInline, 220);
      }
    };

    main.addEventListener("touchstart", onTouchStart, { passive: true });
    main.addEventListener("touchmove", onTouchMove, { passive: false });
    main.addEventListener("touchend", onTouchEnd);
    main.addEventListener("touchcancel", onTouchEnd);
    return () => {
      main.removeEventListener("touchstart", onTouchStart);
      main.removeEventListener("touchmove", onTouchMove);
      main.removeEventListener("touchend", onTouchEnd);
      main.removeEventListener("touchcancel", onTouchEnd);
      clearInline();
      swipeLock.current = false;
    };
  }, [canGoBack, pathname, router]);

  useEffect(() => {
    // The tab-bar links prefetch themselves; these live behind the sheet and
    // would otherwise be fetched only after the user has already tapped.
    for (const item of MORE_ITEMS) router.prefetch(item.href);
  }, [router]);

  // Keyboard-aware scrolling: the on-screen keyboard shrinks the visual
  // viewport without moving the layout viewport, so a focused field near the
  // bottom of a long form (invoice/customer/bank-account forms, settings)
  // ends up hidden behind the keyboard until the user scrolls manually. Nudge
  // whatever is currently focused back into view whenever that happens.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    let frame = 0;
    const publishKeyboardInset = () => {
      const covered = Math.max(0, window.innerHeight - vv.offsetTop - vv.height);
      // The home indicator is already --safe-bottom. A real keyboard is taller.
      const pixels = covered < 120 ? 0 : Math.round(covered);
      const css = `:root{--keyboard-inset:${pixels}px !important}`;
      let tag = document.getElementById("lashkirja-keyboard");
      if (!tag) {
        tag = document.createElement("style");
        tag.id = "lashkirja-keyboard";
        document.head.appendChild(tag);
      }
      if (tag.textContent !== css) tag.textContent = css;
    };
    const reveal = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        publishKeyboardInset();
        const active = document.activeElement;
        if (!(active instanceof HTMLElement)) return;
        if (!["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName)) return;
        const reduceMotion = window.matchMedia(
          "(prefers-reduced-motion: reduce)"
        ).matches;
        active.scrollIntoView({
          block: "center",
          behavior: reduceMotion ? "auto" : "smooth",
        });
      });
    };

    publishKeyboardInset();
    vv.addEventListener("resize", reveal);
    vv.addEventListener("scroll", reveal);
    return () => {
      cancelAnimationFrame(frame);
      vv.removeEventListener("resize", reveal);
      vv.removeEventListener("scroll", reveal);
      const tag = document.getElementById("lashkirja-keyboard");
      if (tag) tag.textContent = ":root{--keyboard-inset:0px !important}";
    };
  }, []);

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
        const nextUser: ShellUser = me.user ?? {};
        writePageCache(AUTH_CACHE_KEY, nextUser);
        setUser(nextUser);
        setAuthState({ status: "ready" });
        warmTabCaches();
        // Check onboarding state; skip once it has been confirmed done.
        if (readPageCache<boolean>(ONBOARDED_CACHE_KEY)) return;
        return fetch("/api/onboarding", { signal: controller.signal })
          .then((res) => readJson<{ onboarded: boolean; profile: BusinessProfile | null }>(res, ""))
          .then((data) => {
            if (!data) return;
            if (data.onboarded) {
              writePageCache(ONBOARDED_CACHE_KEY, true);
            } else {
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
        // With a cached session the revalidation failing (flaky network) must
        // not blank an already-rendered page; the page's own fetches will
        // surface anything real.
        if (readPageCache<ShellUser>(AUTH_CACHE_KEY)) return;
        setAuthState({
          status: "error",
          message: errorMessage(error, "Istunnon tarkistus epäonnistui"),
        });
      });

    return () => controller.abort();
  }, [authAttempt]);

  // Foreground resume: the JS context normally survives backgrounding, so
  // this is a quiet best-effort check, not a full re-render of the auth
  // state — only an explicit 401 (cookie expired/wiped while backgrounded)
  // does anything.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      fetch("/api/auth/me", { credentials: "include" })
        .then((res) => {
          if (res.status === 401) redirectToLogin();
        })
        .catch(() => {});
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

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
        <div className="max-w-lg mx-auto relative flex items-center justify-center px-4 h-14">
          {canGoBack && (
            <button
              type="button"
              onClick={goBack}
              aria-label="Takaisin"
              className="absolute left-1 inset-y-0 my-auto w-11 h-11 flex items-center justify-center text-accent-dark active-press"
            >
              <svg
                className="w-6 h-6"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                aria-hidden
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
            </button>
          )}
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
        ref={mainRef}
        className={`app-main flex-1 max-w-lg mx-auto w-full pt-5 ${
          direction === "forward"
            ? "animate-page-fwd"
            : direction === "back"
              ? "animate-page-back"
              : "animate-page"
        }`}
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
            onComplete={() => {
              writePageCache(ONBOARDED_CACHE_KEY, true);
              setShowOnboarding(false);
            }}
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
                    onClick={() => {
                      if (item.href !== pathname) armNavigation(item.href, "tab");
                    }}
                    className={`flex flex-1 flex-col items-center justify-center gap-0.5 touch-target active:bg-blush/30 transition-colors active-press ${
                      active ? "text-accent-dark" : "text-warm-gray"
                    }`}
                    aria-current={active ? "page" : undefined}
                  >
                    {item.icon(active)}
                    <span
                      className={`text-[13px] leading-tight ${active ? "font-semibold" : "font-medium"}`}
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
                className={`flex flex-1 flex-col items-center justify-center gap-0.5 touch-target active:bg-blush/30 transition-colors active-press ${
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
                <span className={`text-[13px] leading-tight ${moreActive || showMore ? "font-semibold" : "font-medium"}`}>
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
              className="overflow-y-auto overscroll-contain px-3 py-2 sheet-safe-bottom"
            >
              {MORE_ITEMS.map((item) => {
                const active = navActive(pathname, item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => {
                      setMoreOpenOn(null);
                      if (item.href !== pathname) armNavigation(item.href, "tab");
                    }}
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
                onClick={() => {
                  setProfileOpenOn(null);
                  if (pathname !== "/asetukset") armNavigation("/asetukset", "tab");
                }}
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

