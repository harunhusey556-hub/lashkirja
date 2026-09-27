"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { LoadingState } from "@/components/AsyncState";
import { ConnectionNotice } from "@/components/ScreenState";
import { OnboardingModal } from "@/components/OnboardingModal";
import { AiChatDrawer } from "@/components/AiChatDrawer";
import {
  errorMessage,
  isUnauthorized,
  readJson,
  redirectToLogin,
  leaveAfterSignOut,
} from "@/components/clientFetch";

import type { BusinessProfile } from "@/lib/onboarding";
import BottomSheet from "@/components/BottomSheet";
import { AppLock } from "@/components/AppLock";
import { apiFetch } from "@/components/clientFetch";
import { setDraftOwner } from "@/lib/draft-store";
import { readPageCache, writePageCache } from "@/lib/page-cache";
import { syncPageHiddenFlag } from "@/lib/page-activity";
import { helsinkiMonthKey } from "@/lib/validation";
import { bumpNavEpoch } from "@/lib/screen-state";
import {
  armNavigation,
  consumeDirection,
  markHistoryBack,
  performInAppBack,
  recordRoute,
  type NavDirection,
} from "@/lib/nav-direction";
import { hapticSelection } from "@/lib/haptics";
import { anyFormDirty, requestLeave } from "@/lib/form-guard";
import { UnsavedChangesHost } from "@/components/UnsavedChangesHost";
import {
  avatarRoot,
  backTarget,
  matchNav,
  rootIsActive,
  shellShowsBack,
  tabRoots,
  type NavEntry,
} from "@/lib/navigation";

function RootIcon({ id, active, className }: { id: string; active: boolean; className?: string }) {
  const tone = className ?? `h-6 w-6 ${active ? "text-accent" : "text-warm-gray"}`;
  if (id === "etusivu") {
    return (
      <svg className={tone} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1v-9.5Z" />
      </svg>
    );
  }
  if (id === "kuitit") {
    return (
      <svg className={tone} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M9 12h6m-6 4h6m2 5H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5.586a1 1 0 0 1 .707.293l5.414 5.414a1 1 0 0 1 .293.707V19a2 2 0 0 1-2 2Z" />
      </svg>
    );
  }
  if (id === "myynti") {
    return (
      <svg className={tone} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M3 6h18M3 12h18M3 18h10" />
      </svg>
    );
  }
  if (id === "pankki") {
    return (
      <svg className={tone} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M3 10h18M5 10V8.5L12 4l7 4.5V10M6 10v7m4-7v7m4-7v7m4-7v7M4 20h16" />
      </svg>
    );
  }
  if (id === "kirjanpito") {
    return (
      <svg className={tone} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M7 3.5h8.5L19 7v13.5H7A2.5 2.5 0 0 1 4.5 18V6A2.5 2.5 0 0 1 7 3.5Z" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M9 12h6M9 16h4" />
      </svg>
    );
  }
  if (id === "raportit") {
    return (
      <svg className={tone} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M4 19V5m0 14h16M8 16v-5m4 5V8m4 8v-3" />
      </svg>
    );
  }
  return (
    <svg className={tone} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M19.4 15a7.8 7.8 0 0 0 .1-2l2-1.2-2-3.4-2.2.6a8 8 0 0 0-1.7-1L15.2 6h-4.4L10.4 8a8 8 0 0 0-1.7 1L6.5 8.4 4.5 11.8 6.5 13a7.8 7.8 0 0 0 .1 2l-2 1.2 2 3.4 2.2-.6a8 8 0 0 0 1.7 1l.4 2h4.4l.4-2a8 8 0 0 0 1.7-1l2.2.6 2-3.4-2-1.2Z" />
    </svg>
  );
}

type ShellUser = { userId?: string; email?: string; firstName?: string };

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
  return helsinkiMonthKey();
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

function openRoot(
  href: string,
  pathname: string,
  router: { push: (href: string) => void }
) {
  if (href === pathname) return;
  requestLeave(() => {
    armNavigation(href, "tab");
    router.push(href);
  });
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const [authAttempt, setAuthAttempt] = useState(0);
  const [authState, setAuthState] = useState<
    { status: "checking" | "ready" | "error"; message?: string; error?: unknown }
  >(() =>
    readPageCache<ShellUser>(AUTH_CACHE_KEY) ? { status: "ready" } : { status: "checking" }
  );
  const [showOnboarding, setShowOnboarding] = useState(false);
  // Stored with the path it was opened on, so a route change closes it without
  // an effect that would re-render twice.
  const [profileOpenOn, setProfileOpenOn] = useState<string | null>(null);
  const [addOpenOn, setAddOpenOn] = useState<string | null>(null);
  const [chatOpenOn, setChatOpenOn] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState("");
  const [user, setUser] = useState<ShellUser | null>(() => readPageCache<ShellUser>(AUTH_CACHE_KEY));
  const [onboardingProfile, setOnboardingProfile] = useState<BusinessProfile | null>(null);

  useEffect(() => {
    setDraftOwner(user?.userId ?? null);
  }, [user?.userId]);

  const pathname = usePathname();
  const router = useRouter();
  const title = matchNav(pathname)?.label ?? "Koti";
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
  const canGoBack = shellShowsBack(pathname);
  const back = backTarget(pathname);

  useEffect(() => {
    recordRoute(pathname, direction);
    document.dispatchEvent(new Event("lashkirja-dismiss-press"));
    bumpNavEpoch();
  }, [pathname, direction]);

  function goBack() {
    requestLeave(() => performInAppBack(pathname, router, back?.href));
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
        const go = () => {
          swipeLock.current = true;
          const navigate = () => {
            performInAppBack(pathname, router);
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
        };
        if (anyFormDirty()) {
          clearInline();
          requestLeave(go);
          return;
        }
        go();
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

  // UsableArea owns frame size. This only keeps a focused field inside the
  // content scroller when the keyboard changes the visual viewport.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    let raf = 0;
    const reveal = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const active = document.activeElement;
        if (!(active instanceof HTMLElement)) return;
        if (!["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName)) return;
        active.scrollIntoView({ block: "nearest", behavior: "auto" });
      });
    };
    vv.addEventListener("resize", reveal);
    vv.addEventListener("scroll", reveal);
    return () => {
      cancelAnimationFrame(raf);
      vv.removeEventListener("resize", reveal);
      vv.removeEventListener("scroll", reveal);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    apiFetch("/api/auth/me", {
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
        setDraftOwner(nextUser.userId ?? null);
        setUser(nextUser);
        setAuthState({ status: "ready" });
        warmTabCaches();
        // Check onboarding state; skip once it has been confirmed done.
        if (readPageCache<boolean>(ONBOARDED_CACHE_KEY)) return;
        return apiFetch("/api/onboarding", { signal: controller.signal })
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
          error,
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
      const hidden = document.visibilityState === "hidden";
      syncPageHiddenFlag(hidden);
      if (hidden) return;
      apiFetch("/api/auth/me", { credentials: "include" })
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

  const showProfile = profileOpenOn === pathname;
  const chatOpen = chatOpenOn === pathname;
  const initials = (user?.firstName?.trim()?.[0] || user?.email?.trim()?.[0] || "").toUpperCase();

  async function handleSignOut() {
    if (signingOut) return;
    setSigningOut(true);
    setSignOutError("");
    const left = await leaveAfterSignOut();
    if (!left) {
      setSigningOut(false);
      setSignOutError("Uloskirjautuminen epäonnistui. Istunto voi olla yhä voimassa.");
    }
  }

  const addOpen = addOpenOn === pathname;

  function goToRoot(href: string) {
    void hapticSelection();
    setAddOpenOn(null);
    setProfileOpenOn(null);
    openRoot(href, pathname, router);
  }

  function renderTab(item: NavEntry) {
    const active = rootIsActive(pathname, item.id);
    return (
      <button
        key={item.id}
        type="button"
        onClick={() => goToRoot(item.path)}
        className={`flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 touch-target active:bg-blush/30 transition-colors active-press ${
          active ? "text-accent-dark" : "text-warm-gray"
        }`}
        aria-current={active ? "page" : undefined}
      >
        <RootIcon id={item.id} active={active} />
        <span
          className={`max-w-full truncate text-[11px] leading-tight ${active ? "font-semibold" : "font-medium"}`}
        >
          {item.label}
        </span>
      </button>
    );
  }

  return (
    <AppLock>
    {authState.status === "ready" && (
      <aside className="app-sidebar" aria-hidden={false}>
        <p className="px-4 pb-2 pt-4 text-xs font-semibold uppercase tracking-wide text-warm-gray">LashKirja</p>
        <div className="px-2 pb-3">
          <button
            type="button"
            onClick={() => setAddOpenOn(pathname)}
            aria-haspopup="dialog"
            className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-charcoal text-sm font-semibold text-white active-press"
          >
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
              <path strokeLinecap="round" d="M12 5v14M5 12h14" />
            </svg>
            Lisää
          </button>
        </div>
        <nav aria-label="Päävalikko" className="flex flex-1 flex-col gap-1 px-2">
          {tabRoots().map((item) => {
            const active = rootIsActive(pathname, item.id);
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => goToRoot(item.path)}
                aria-current={active ? "page" : undefined}
                className={`flex min-h-12 items-center gap-3 rounded-xl px-3 text-left text-sm active-press ${
                  active ? "bg-blush font-semibold text-accent-dark" : "font-medium text-charcoal"
                }`}
              >
                <RootIcon
                  id={item.id}
                  active={active}
                  className={`h-5 w-5 ${active ? "text-accent" : "text-warm-gray"}`}
                />
                <span className="truncate">{item.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="mt-auto px-2 pb-4">
          <button
            type="button"
            onClick={() => goToRoot(avatarRoot().path)}
            aria-current={rootIsActive(pathname, "asetukset") ? "page" : undefined}
            className="flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-medium text-charcoal active-press"
          >
            <RootIcon id="asetukset" active={rootIsActive(pathname, "asetukset")} className="h-5 w-5 text-warm-gray" />
            Asetukset
          </button>
        </div>
      </aside>
    )}
    <div className="app-frame">
      <UnsavedChangesHost />
      <header
        className="app-header z-40 bg-white/90 backdrop-blur-md border-b border-warm-gray-light/30"
        onContextMenu={(event) => event.preventDefault()}
      >
        <div className="app-header-row mx-auto min-h-14 max-w-lg px-1 md:max-w-3xl">
          <div className="flex h-11 min-w-11 items-center justify-self-start">
            {canGoBack && (
              <button
                type="button"
                onClick={goBack}
                aria-label="Takaisin"
                className="flex h-11 max-w-full items-center gap-0.5 pl-1 pr-2 text-accent-dark active-press"
              >
                <svg className="h-6 w-6 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                </svg>
                {back && <span className="truncate text-sm font-medium">{back.label}</span>}
              </button>
            )}
          </div>
          <p className="min-w-0 max-w-[11rem] truncate text-center text-base font-medium text-charcoal md:max-w-sm">{title}</p>

          {authState.status === "ready" ? (
            <div className="flex items-center justify-self-end">
            <button
              type="button"
              onClick={() => {
                void hapticSelection();
                setChatOpenOn(pathname);
              }}
              aria-label="Avustaja"
              className="assistant-button active-press flex h-11 items-center justify-center gap-1 rounded-full bg-accent px-2.5 text-sm font-medium text-white"
            >
              <svg className="h-5 w-5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h8M8 14h5M6 5h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H11l-4 3v-3H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z" />
              </svg>
              <span className="assistant-word">Avustaja</span>
            </button>
            <button
              type="button"
              onClick={() => setProfileOpenOn((open) => (open === pathname ? null : pathname))}
              aria-label="Profiili, asetukset ja uloskirjautuminen"
              aria-haspopup="dialog"
              className="flex h-11 w-11 items-center justify-center active-press"
            >
              <span className="w-8 h-8 rounded-full bg-blush text-accent-dark text-xs font-semibold flex items-center justify-center border border-blush-dark/40">
                {initials || (
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} aria-hidden>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8a7 7 0 0 1 14 0" />
                  </svg>
                )}
              </span>
            </button>
            </div>
          ) : (
            <div className="w-11" aria-hidden />
          )}
        </div>
      </header>

      <main
        // Keyed on the path so the enter animation replays on every navigation.
        key={pathname}
        ref={mainRef}
        className={`app-main mx-auto w-full max-w-lg flex-1 pt-5 md:max-w-3xl ${
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
          <ConnectionNotice
            error={authState.error}
            fallback={authState.message || "Istunnon tarkistus epäonnistui"}
            onRetry={retryAuth}
          />
        ) : (
          children
        )}
      </main>

      {authState.status === "ready" && (
        <>
          <AiChatDrawer open={chatOpen} onClose={() => setChatOpenOn(null)} />
          <OnboardingModal
            isOpen={showOnboarding}
            initialProfile={onboardingProfile ?? undefined}
            onComplete={() => {
              writePageCache(ONBOARDED_CACHE_KEY, true);
              setShowOnboarding(false);
            }}
          />

          <nav
            className="app-tab-bar z-50 bg-white/95 backdrop-blur-md border-t border-warm-gray-light/40"
            aria-label="Päävalikko"
            onContextMenu={(event) => event.preventDefault()}
          >
            <div className="mx-auto flex h-[var(--app-tab-height)] max-w-lg items-stretch">
              {tabRoots().slice(0, 2).map((item) => renderTab(item))}
              <div className="flex min-w-0 flex-1 items-center justify-center">
                <button
                  type="button"
                  onClick={() => {
                    void hapticSelection();
                    setAddOpenOn(pathname);
                  }}
                  aria-label="Lisää"
                  aria-haspopup="dialog"
                  aria-expanded={addOpen}
                  className="flex h-12 w-12 items-center justify-center rounded-full bg-charcoal text-white active-press"
                >
                  <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
                    <path strokeLinecap="round" d="M12 5v14M5 12h14" />
                  </svg>
                </button>
              </div>
              {tabRoots().slice(2).map((item) => renderTab(item))}
            </div>
          </nav>

          <BottomSheet
            isOpen={addOpen}
            onClose={() => setAddOpenOn(null)}
            title="Lisää"
            labelledBy="add-sheet-title"
            heightClass="max-h-[70dvh]"
          >
            <div className="space-y-2 px-3 py-2 sheet-safe-bottom">
              <Link
                href="/kuitit/uusi"
                onClick={() => setAddOpenOn(null)}
                className="flex items-center gap-3 rounded-2xl bg-charcoal px-4 py-4 text-white active-press"
              >
                <span className="text-base font-semibold">Kuvaa kuitti</span>
              </Link>
              <div className="overflow-hidden rounded-2xl bg-white shadow-sm divide-y divide-warm-gray-light/25">
                {[
                  { href: "/pankki/tapahtumat", label: "Tuo tiliote", hint: "CSV, XLSX, camt tai PDF" },
                  { href: "/laskut/uusi", label: "Uusi myyntilasku" },
                  { href: "/asetukset/sahkoposti", label: "Hae sähköpostista" },
                ].map((row) => (
                  <Link
                    key={row.href}
                    href={row.href}
                    onClick={() => setAddOpenOn(null)}
                    className="flex flex-col px-4 py-3.5 active:bg-blush/30 touch-target"
                  >
                    <span className="text-sm font-medium text-charcoal">{row.label}</span>
                    {row.hint && <span className="mt-0.5 text-xs text-warm-gray">{row.hint}</span>}
                  </Link>
                ))}
              </div>
            </div>
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
              <button
                type="button"
                onClick={() => goToRoot(avatarRoot().path)}
                className="w-full flex items-center gap-3 px-4 py-3.5 rounded-2xl text-left active:bg-blush/40 touch-target"
              >
                <RootIcon id="asetukset" active={false} className="h-4 w-4 text-warm-gray" />
                <span className="text-sm font-medium text-charcoal">Asetukset</span>
              </button>
              {signOutError && (
                <p className="px-4 text-sm text-danger" role="alert">
                  {signOutError}
                </p>
              )}
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
    </AppLock>
  );
}

