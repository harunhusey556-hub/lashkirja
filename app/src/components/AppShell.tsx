"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  BookOpen,
  Camera,
  ChartColumn,
  ChevronLeft,
  FilePlus,
  FileText,
  FileUp,
  House,
  LogOut,
  Mail,
  MessageSquareText,
  Plus,
  Settings,
  User,
  type LucideIcon,
} from "lucide-react";
import { Icon, IconTile } from "@/components/ds/Icon";
import { AppMark } from "@/components/AppMark";
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

/** Tab bar / sidebar glyph per root (see `ds/Icon.tsx` for the set and sizes). */
const ROOT_ICONS: Record<string, LucideIcon> = {
  etusivu: House,
  myynti: FileText,
  kirjanpito: BookOpen,
  raportit: ChartColumn,
  asetukset: Settings,
};

function rootIcon(id: string): LucideIcon {
  return ROOT_ICONS[id] ?? Settings;
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
  const navEntry = matchNav(pathname);
  const isDetail = navEntry?.kind === "detail";
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
            performInAppBack(pathname, router, back?.href);
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
  }, [canGoBack, pathname, router, back?.href]);

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
        className={`flex min-w-0 flex-1 flex-col items-center justify-center gap-1 touch-target transition-colors active-press ${
          active ? "text-accent" : "text-ink-2"
        }`}
        aria-current={active ? "page" : undefined}
      >
        <Icon icon={rootIcon(item.id)} size="tab" />
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
        <p className="flex items-center gap-2.5 px-5 pb-4 pt-5 text-[17px] font-bold tracking-[-0.01em] text-ink">
          <AppMark />
          LashKirja
        </p>
        <div className="px-3 pb-3">
          <button
            type="button"
            onClick={() => setAddOpenOn(pathname)}
            aria-haspopup="dialog"
            aria-expanded={addOpen}
            className="flex min-h-12 w-full items-center justify-center gap-2 rounded-card bg-ink text-[15px] font-semibold text-canvas active-press"
          >
            <Icon icon={Plus} strokeWidth={2} />
            Lisää
          </button>
        </div>
        <nav aria-label="Päävalikko" className="flex flex-1 flex-col gap-0.5 px-3">
          {tabRoots().map((item) => {
            const active = rootIsActive(pathname, item.id);
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => goToRoot(item.path)}
                aria-current={active ? "page" : undefined}
                className={`flex min-h-12 items-center gap-3 rounded-card px-3 text-left text-[15px] active-press ${
                  active ? "bg-accent-soft font-semibold text-accent" : "font-medium text-ink"
                }`}
              >
                <Icon icon={rootIcon(item.id)} className={active ? "text-accent" : "text-ink-2"} />
                <span className="truncate">{item.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="mt-auto px-3 pb-4">
          <button
            type="button"
            onClick={() => goToRoot(avatarRoot().path)}
            aria-current={rootIsActive(pathname, "asetukset") ? "page" : undefined}
            className={`flex min-h-12 w-full items-center gap-3 rounded-card px-3 text-left text-[15px] active-press ${
              rootIsActive(pathname, "asetukset") ? "bg-accent-soft font-semibold text-accent" : "font-medium text-ink"
            }`}
          >
            <Icon
              icon={Settings}
              className={rootIsActive(pathname, "asetukset") ? "text-accent" : "text-ink-2"}
            />
            Asetukset
          </button>
        </div>
      </aside>
    )}
    <div className="app-frame" data-tabs={isDetail ? "hidden" : undefined}>
      <UnsavedChangesHost />
      <header
        className="app-header z-40 bg-canvas"
        onContextMenu={(event) => event.preventDefault()}
      >
        {/* px-3 + the 4px inset of each 36px circle inside its 44px hit box puts the avatar's outer
            edge on the same 16px line as the cards below, and the back chevron's stroke on the
            page title's 20px line. */}
        <div className="app-header-row mx-auto min-h-14 w-full max-w-lg px-3 md:max-w-3xl">
          <div className="flex h-11 min-w-11 items-center justify-self-start">
            {canGoBack && (
              <button
                type="button"
                onClick={goBack}
                aria-label={back ? `Takaisin: ${back.label}` : "Takaisin"}
                className="flex h-11 max-w-full items-center gap-0.5 pr-2 text-accent active-press"
              >
                <Icon icon={ChevronLeft} size="tab" strokeWidth={2} />
                {back && <span className="truncate text-[15px] font-medium">{back.label}</span>}
              </button>
            )}
          </div>

          {authState.status === "ready" ? (
            <div className="flex items-center gap-1 justify-self-end">
              <button
                type="button"
                onClick={() => {
                  void hapticSelection();
                  setChatOpenOn(pathname);
                }}
                aria-label="Avustaja"
                className="header-circle active-press flex h-11 w-11 items-center justify-center"
              >
                <span className="flex h-9 w-9 items-center justify-center rounded-full border border-line bg-surface text-ink">
                  <Icon icon={MessageSquareText} />
                </span>
              </button>
              <button
                type="button"
                onClick={() => setProfileOpenOn((open) => (open === pathname ? null : pathname))}
                aria-label="Profiili, asetukset ja uloskirjautuminen"
                aria-haspopup="dialog"
                className="header-circle active-press flex h-11 w-11 items-center justify-center"
              >
                <span className="flex h-9 w-9 items-center justify-center rounded-full border border-accent-soft bg-accent-soft text-[15px] font-semibold text-accent">
                  {initials || <Icon icon={User} />}
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

          {!isDetail && (
            <nav
              className="app-tab-bar z-50 border-t border-line bg-surface"
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
                    className="flex h-12 w-12 items-center justify-center rounded-full bg-ink text-canvas active-press"
                  >
                    <Icon icon={Plus} size="tab" strokeWidth={2} />
                  </button>
                </div>
                {tabRoots().slice(2).map((item) => renderTab(item))}
              </div>
            </nav>
          )}

          <BottomSheet
            isOpen={addOpen}
            onClose={() => setAddOpenOn(null)}
            title="Lisää"
            labelledBy="add-sheet-title"
            heightClass="max-h-[70dvh]"
          >
            <div className="space-y-3 px-4 py-2 sheet-safe-bottom">
              <button
                type="button"
                onClick={() => {
                  setAddOpenOn(null);
                  requestLeave(() => {
                    armNavigation("/kuitit/uusi", "forward");
                    router.push("/kuitit/uusi");
                  });
                }}
                className="flex w-full items-center gap-3 rounded-card bg-ink px-4 py-4 text-left text-canvas active-press"
              >
                <Icon icon={Camera} size="tab" />
                <span className="min-w-0">
                  <span className="block text-base font-semibold">Kuvaa kuitti</span>
                  <span className="block text-[13px] text-canvas/70">
                    Luetaan automaattisesti ja liitetään tapahtumaan
                  </span>
                </span>
              </button>
              <div className="overflow-hidden rounded-card border border-line bg-surface divide-y divide-line">
                {(
                  [
                    { href: "/pankki/tapahtumat", label: "Tuo tiliote", hint: "CSV, XLSX, camt tai PDF", icon: FileUp },
                    { href: "/laskut/uusi", label: "Uusi myyntilasku", hint: undefined, icon: FilePlus },
                    { href: "/asetukset/sahkoposti", label: "Hae sähköpostista", hint: undefined, icon: Mail },
                  ] as const satisfies readonly { href: string; label: string; hint?: string; icon: LucideIcon }[]
                ).map((row) => (
                  <button
                    key={row.href}
                    type="button"
                    onClick={() => {
                      setAddOpenOn(null);
                      requestLeave(() => {
                        armNavigation(row.href, "forward");
                        router.push(row.href);
                      });
                    }}
                    className="flex w-full items-center gap-3 px-4 py-3.5 text-left active-press touch-target"
                  >
                    <IconTile>
                      <Icon icon={row.icon} />
                    </IconTile>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[15px] font-medium text-ink">{row.label}</span>
                      {row.hint && <span className="mt-0.5 block truncate text-[13px] text-ink-2">{row.hint}</span>}
                    </span>
                  </button>
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
            <div className="px-4 py-2 sheet-safe-bottom">
              {signOutError && (
                <p className="mb-2 px-1 text-sm text-danger" role="alert">
                  {signOutError}
                </p>
              )}
              <div className="overflow-hidden rounded-card border border-line bg-surface divide-y divide-line">
                <button
                  type="button"
                  onClick={() => goToRoot(avatarRoot().path)}
                  aria-current={rootIsActive(pathname, "asetukset") ? "page" : undefined}
                  className="w-full flex items-center gap-3 px-4 py-3.5 text-left active-press touch-target"
                >
                  <IconTile>
                    <Icon icon={Settings} />
                  </IconTile>
                  <span className="text-[15px] font-medium text-ink">Asetukset</span>
                </button>
                <button
                  type="button"
                  onClick={handleSignOut}
                  disabled={signingOut}
                  className="w-full flex items-center gap-3 px-4 py-3.5 text-left active-press disabled:opacity-60 touch-target"
                >
                  <IconTile tone="danger">
                    {signingOut ? (
                      <span
                        className="h-4 w-4 animate-spin rounded-full border-2 border-danger/40 border-t-danger motion-reduce:animate-none"
                        aria-hidden
                      />
                    ) : (
                      <Icon icon={LogOut} />
                    )}
                  </IconTile>
                  <span className="text-[15px] font-medium text-danger">
                    {signingOut ? "Kirjaudutaan ulos…" : "Kirjaudu ulos"}
                  </span>
                </button>
              </div>
            </div>
          </BottomSheet>
        </>
      )}
    </div>
    </AppLock>
  );
}

