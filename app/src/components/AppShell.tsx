"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
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
import { ConnectivityBanner } from "@/components/ConnectivityBanner";
import { OnboardingChat } from "@/components/onboarding/OnboardingChat";
import { OnboardingResumeCard } from "@/components/onboarding/OnboardingResumeCard";
import { isOnboardingSnoozed } from "@/lib/onboarding-gate";
import { AiChatDrawer } from "@/components/AiChatDrawer";
import { ToastHost } from "@/components/ToastHost";
import { useSignOut } from "@/components/useSignOut";

import BottomSheet from "@/components/BottomSheet";
import { AppLock } from "@/components/AppLock";
import { apiFetch, readJson } from "@/components/clientFetch";
import { useSession } from "@/components/SessionProvider";
import { IS_MOBILE_BUILD } from "@/lib/build-target";
import { markFirstScreen, onFirstScreen } from "@/lib/splash";
import { readPageCache, writePageCache } from "@/lib/page-cache";
import { helsinkiMonthKey } from "@/lib/validation";
import { bumpNavEpoch } from "@/lib/screen-state";
import {
  adoptTab,
  armNavigation,
  consumeDirection,
  inAppPrevious,
  landingPath,
  markHistoryBack,
  performInAppBack,
  previousAfterLanding,
  recordRoute,
  tabAfterLanding,
  tabTarget,
  updateCurrentHref,
  type NavDirection,
} from "@/lib/nav-direction";
import { hapticImpact } from "@/lib/haptics";
import { EDGE_FINISH_MS, EDGE_ZONE, edgeSwipeCommits, VelocityTracker } from "@/lib/gesture";
import { anyFormDirty, requestLeave } from "@/lib/form-guard";
import { UnsavedChangesHost } from "@/components/UnsavedChangesHost";
import { captureWithCamera, chooseDocuments, isNativeShell } from "@/lib/native-pick";
import {
  PENDING_CAPTURE_ROUTES,
  STATEMENT_ACCEPT,
  STATEMENT_FILE_TYPES,
  stashPendingCapture,
  type PendingCaptureKind,
} from "@/lib/pending-capture";
import { showToast } from "@/lib/toast";
import {
  forgetScroll,
  keepPageNode,
  mountSnapshot,
  pageNodeFor,
  prefersReducedMotion,
  recalledScroll,
  rememberScroll,
  removeSnapshotAfter,
} from "@/lib/page-transition";
import {
  avatarRoot,
  backTarget,
  matchNav,
  navRelation,
  rootIdOf,
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

/** Set once the onboarding endpoint has confirmed the user is onboarded. */
const ONBOARDED_CACHE_KEY = "shell-onboarded";

/**
 * The avatar's initial, readable synchronously on the very first paint
 * (AUTH-28): the session cache is async on a cold start, so without this
 * the header shows a generic icon and then flips to the letter. One
 * character, not sensitive; removed on sign-out.
 */
const AVATAR_INITIAL_KEY = "lashkirja.shell.initial.v1";

function readStoredInitial(): string {
  try {
    return window.localStorage.getItem(AVATAR_INITIAL_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeStoredInitial(value: string | null): void {
  try {
    if (value) window.localStorage.setItem(AVATAR_INITIAL_KEY, value);
    else window.localStorage.removeItem(AVATAR_INITIAL_KEY);
  } catch {
    // Private mode or storage blocked: the icon fallback stays.
  }
}

const noSubscribe = () => () => {};

/** Push/pop duration (--dur-push) plus a margin for the snapshot fallback timer. */
const PUSH_FALLBACK_MS = 360;
/** Longest the native splash waits for the first page to have real content. */
const SPLASH_MAX_WAIT_MS = 350;

let warmedTabs = false;

function currentMonthKey(): string {
  return helsinkiMonthKey();
}

/**
 * Warm-up of the main tab payloads, so even the first tap on each tab paints
 * with data instead of a skeleton. Keys and shapes mirror what each page
 * caches for itself; existing entries are never overwritten.
 *
 * Web: in idle time, in parallel. Mobile (SHELL-08): once, 1.5 s after the
 * first screen, one request at a time, so it never competes with the
 * page's own request on a slow link.
 */
async function warmTabCaches(sequential: boolean) {
  if (warmedTabs) return;
  warmedTabs = true;

  const warm = (url: string, key: string, pick: (data: Record<string, unknown>) => unknown) => {
    if (readPageCache(key) !== null) return Promise.resolve();
    return apiFetch(url, { credentials: "include" })
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

  const month = currentMonthKey();
  // Key must match the kuitit page's default query (its default sort is
  // part of the query string).
  const jobs: Array<() => Promise<void>> = [
    () =>
      warm(`/api/dashboard?month=${month}`, `dashboard:${month}`, (d) =>
        Number.isFinite(d.income) && Number.isFinite(d.expenses) && d.vat ? d : undefined
      ),
    () => warm("/api/invoices?", "invoices", (d) => (d.invoices && d.aging ? d : undefined)),
    () => warm("/api/receipts?sort=date_desc", "receipts:sort=date_desc", (d) => d.receipts ?? []),
    () => warm("/api/receipts?reviewStatus=pending", "receipts-pending", (d) => d.receipts ?? []),
    () => warm("/api/statements", "statements", (d) => d.statements ?? []),
    () => warm("/api/bank-accounts", "bank-overview", (d) => (d.accounts ? d : undefined)),
  ];
  if (sequential) {
    for (const job of jobs) await job();
  } else {
    await Promise.all(jobs.map((job) => job()));
  }
}

/**
 * Shared by every tab-bar / sidebar root `<Link>` and the profile sheet's
 * "Asetukset" row (C1.5, IA-25). Tab taps are silent (no haptic, as on iOS).
 * - Another tab: go to that tab's last screen (its root the first time),
 *   armed as "tab" (no animation) and owned by the tapped tab.
 * - The active tab: scroll to the top first; tapped again at the top, pop to
 *   the tab root.
 * A `<Link>` navigates by its own default click when the target is its own
 * href; otherwise (a remembered screen, a `<button>`) this pushes. A dirty
 * form intercepts and goes through the unsaved-changes prompt first.
 */
function handleTabClick(
  event: { preventDefault: () => void; currentTarget?: EventTarget | null },
  tab: { id: string; path: string },
  context: {
    pathname: string;
    activeTab: string | null;
    main: HTMLElement | null;
    router: { push: (href: string) => void };
    /** Re-render after the current screen moved into the tapped tab. */
    refresh: () => void;
  }
) {
  const { pathname, activeTab, main, router, refresh } = context;
  const isLink = typeof HTMLAnchorElement !== "undefined" && event.currentTarget instanceof HTMLAnchorElement;

  if (activeTab === tab.id) {
    event.preventDefault();
    if (main && main.scrollTop > 1) {
      const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      main.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
      return;
    }
    if (pathname === tab.path) return;
    const popToRoot = () => {
      armNavigation(tab.path, "back");
      router.push(tab.path);
    };
    if (anyFormDirty()) requestLeave(popToRoot);
    else popToRoot();
    return;
  }

  const target = tabTarget(tab.id) ?? tab.path;
  const targetPath = target.split("?")[0];
  if (targetPath === pathname) {
    // Already on that tab's screen (reached by a push from another tab):
    // it becomes that tab's root screen, with no navigation at all.
    event.preventDefault();
    adoptTab(tab.id, pathname);
    refresh();
    return;
  }
  const go = () => {
    armNavigation(targetPath, "tab", tab.id);
    router.push(target);
  };
  if (anyFormDirty()) {
    event.preventDefault();
    requestLeave(go);
    return;
  }
  if (isLink && target === tab.path) {
    armNavigation(targetPath, "tab", tab.id);
    return;
  }
  event.preventDefault();
  // One frame later, so a closing sheet's exit and the page change overlap.
  if (isLink) go();
  else requestAnimationFrame(go);
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const { status: sessionStatus, user } = useSession();
  const [showOnboarding, setShowOnboarding] = useState(false);
  // Stored with the path it was opened on, so a route change closes it without
  // an effect that would re-render twice.
  const [profileOpenOn, setProfileOpenOn] = useState<string | null>(null);
  const [addOpenOn, setAddOpenOn] = useState<string | null>(null);
  const [chatOpenOn, setChatOpenOn] = useState<string | null>(null);
  // "Ohita nyt" hides the onboarding for 24 h; Koti then offers it again.
  const [onboardingSnoozed, setOnboardingSnoozed] = useState(false);
  // AUTH-03: the one sign-out flow (queued-receipts confirm included). It also
  // mounts the offline queue's drain driver here, so the driver keeps running
  // app-wide while signed in (Task 10).
  const { requestSignOut, signingOut, signOutError, confirmDialog } = useSignOut({
    onBeforeSignOut: () => writeStoredInitial(null),
  });

  const pathname = usePathname();
  const router = useRouter();
  const navEntry = matchNav(pathname);
  const isDetail = navEntry?.kind === "detail";
  const mainRef = useRef<HTMLElement>(null);
  const swipeLock = useRef(false);
  // Adjusting state during render is how a new pathname picks its enter
  // direction before paint. The server skips this so the first HTML matches
  // the client's first visit (direction "none" until a real navigation).
  // Bumped when the current screen is adopted by another tab (no navigation).
  const [, setTabEpoch] = useState(0);
  const [navFrame, setNavFrame] = useState<{ path: string; direction: NavDirection }>({
    path: "",
    direction: "none",
  });
  if (typeof window !== "undefined" && navFrame.path !== pathname) {
    setNavFrame({ path: pathname, direction: consumeDirection(pathname, navRelation) });
  }
  const direction = navFrame.path === pathname ? navFrame.direction : "none";
  // The highlighted tab is the tab the current stack belongs to, not the
  // path's own root: a cross-tab push keeps its origin tab lit (IA-07).
  const activeTabId = typeof window === "undefined" ? rootIdOf(pathname) : tabAfterLanding(pathname, direction);
  // SHELL-31: the back button returns to the real previous screen when there
  // is one, so the label names that screen, not the logical parent.
  const previousScreen = typeof window === "undefined" ? null : previousAfterLanding(pathname, direction);
  // C4: every screen reached by a push has a back, a root included (Koti ->
  // Myynti link is a push that shows "< Koti", IA-07).
  const canGoBack = shellShowsBack(pathname) || (navEntry?.kind === "root" && previousScreen !== null);
  const back = backTarget(pathname);
  const previousEntry = previousScreen ? matchNav(previousScreen) : null;
  const backLabel =
    previousScreen && previousEntry && previousScreen !== back?.href && !previousEntry.path.includes(":")
      ? previousEntry.label
      : null;

  // The current page wrapper and the one it replaced (React detaches the old
  // keyed wrapper but leaves its subtree intact: that node is the snapshot).
  const pageNodeRef = useRef<HTMLDivElement | null>(null);
  const replacedPageRef = useRef<HTMLDivElement | null>(null);
  const setPageNode = useCallback((node: HTMLDivElement | null) => {
    if (!node || pageNodeRef.current === node) return;
    if (pageNodeRef.current) replacedPageRef.current = pageNodeRef.current;
    pageNodeRef.current = node;
  }, []);
  const pathnameRef = useRef(pathname);
  const previousPathRef = useRef<string | null>(null);
  // Set when an edge swipe already moved the pages into place.
  const swipeHandoffRef = useRef<(() => void) | null>(null);
  const pendingScrollRef = useRef<{ top: number; until: number } | null>(null);

  // C4 (IA-14): once the page's large title has scrolled under the header,
  // a 17 px inline title fades in at the centre with a hairline under the
  // header. Direct DOM writes, once per frame: no re-render while scrolling.
  const headerRef = useRef<HTMLElement>(null);
  const inlineTitleRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    const main = mainRef.current;
    const header = headerRef.current;
    const inline = inlineTitleRef.current;
    if (!main || !header || !inline) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const heading = main.querySelector<HTMLElement>(".app-page h1");
      const collapsed = Boolean(
        heading && heading.getBoundingClientRect().bottom <= main.getBoundingClientRect().top + 2
      );
      if (collapsed) {
        const text = heading?.textContent?.trim() ?? "";
        if (inline.textContent !== text) inline.textContent = text;
      }
      if (collapsed !== (header.dataset.collapsed === "true")) {
        if (collapsed) header.dataset.collapsed = "true";
        else delete header.dataset.collapsed;
      }
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    main.addEventListener("scroll", schedule, { passive: true });
    schedule();
    return () => {
      main.removeEventListener("scroll", schedule);
      cancelAnimationFrame(raf);
    };
  }, [pathname]);

  // Scroll memory per route (SHELL-07). <main> persists across navigations.
  useEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    const onScroll = () => rememberScroll(pathnameRef.current, main.scrollTop);
    const cancelPending = () => {
      pendingScrollRef.current = null;
    };
    main.addEventListener("scroll", onScroll, { passive: true });
    main.addEventListener("touchstart", cancelPending, { passive: true });
    main.addEventListener("wheel", cancelPending, { passive: true });
    return () => {
      main.removeEventListener("scroll", onScroll);
      main.removeEventListener("touchstart", cancelPending);
      main.removeEventListener("wheel", cancelPending);
    };
  }, []);

  // The connectivity banner makes room by changing <main>'s padding-top,
  // which now snaps (no layout-property animation). The page slides the same
  // distance with a transform instead, so the content still moves in step
  // with the banner's own slide. Skipped under reduced motion.
  useEffect(() => {
    const main = mainRef.current;
    const frame = main?.closest<HTMLElement>(".app-frame");
    if (!main || !frame || typeof MutationObserver === "undefined") return;
    const room = () =>
      frame.dataset.banner === "shown" ? parseFloat(frame.style.getPropertyValue("--banner-h")) || 0 : 0;
    let last = room();
    const observer = new MutationObserver(() => {
      const next = room();
      const delta = next - last;
      last = next;
      const page = pageNodeRef.current;
      if (!delta || !page || prefersReducedMotion() || typeof page.animate !== "function") return;
      const easing = getComputedStyle(document.documentElement).getPropertyValue("--ease-out").trim() || "ease-out";
      page.animate([{ transform: `translateY(${-delta}px)` }, { transform: "translateY(0)" }], {
        duration: 220,
        easing,
        composite: "add",
      });
    });
    observer.observe(frame, { attributes: true, attributeFilter: ["data-banner", "style"] });
    return () => observer.disconnect();
  }, []);

  // A back or tab landing restores the remembered scroll position, but the
  // page may still be loading (too short to scroll that far). Re-apply it as
  // the page grows, until it sticks or 2 s pass. (C1.1: there is no fitting
  // or "snug" mode any more; every page keeps the same insets and always has
  // at least a 1 px scroll range, see .app-main > .app-page in globals.css.)
  const applyPendingScroll = useCallback(() => {
    const main = mainRef.current;
    const pending = pendingScrollRef.current;
    if (!main || !pending) return;
    if (performance.now() > pending.until) pendingScrollRef.current = null;
    else {
      main.scrollTop = pending.top;
      if (main.scrollTop >= pending.top - 1) pendingScrollRef.current = null;
    }
  }, []);

  useLayoutEffect(() => {
    const main = mainRef.current;
    const page = pageNodeRef.current;
    if (!main) return;
    applyPendingScroll();
    if (typeof ResizeObserver === "undefined") return;
    let raf = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(applyPendingScroll);
    });
    observer.observe(main, { box: "border-box" });
    if (page) observer.observe(page);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [pathname, applyPendingScroll]);

  // Navigation: route memory, back label, scroll restore and the push/pop.
  useLayoutEffect(() => {
    const main = mainRef.current;
    const from = previousPathRef.current;
    previousPathRef.current = pathname;
    pathnameRef.current = pathname;
    recordRoute(pathname, direction);

    if (!main || from === null || from === pathname) return;

    const oldPage = replacedPageRef.current;
    replacedPageRef.current = null;
    const oldPaddingTop = getComputedStyle(main).paddingTop;
    const oldScroll = recalledScroll(from);
    if (oldPage) keepPageNode(from, oldPage);

    // Forward lands at the top; back and tab switches return to where the
    // user left that screen (iOS keeps a tab's scroll position).
    const target = direction === "forward" ? 0 : recalledScroll(pathname);
    if (direction === "forward") forgetScroll(pathname);
    main.scrollTop = target;
    pendingScrollRef.current =
      main.scrollTop < target - 1 ? { top: target, until: performance.now() + 2000 } : null;

    const handoff = swipeHandoffRef.current;
    swipeHandoffRef.current = null;
    if (handoff) {
      handoff();
      return;
    }

    // Tab switches (100+/day) and the first render do not animate (SHELL-06).
    if (direction !== "forward" && direction !== "back") return;

    const enterClass = direction === "forward" ? "page-push-in" : "page-pop-in";
    main.classList.remove("page-push-in", "page-pop-in");
    void main.offsetWidth;
    main.classList.add(enterClass);
    const clearEnter = () => main.classList.remove(enterClass);
    const onEnd = (event: AnimationEvent) => {
      if (event.target === main) clearEnter();
    };
    main.addEventListener("animationend", onEnd, { once: true });
    const enterTimer = window.setTimeout(clearEnter, PUSH_FALLBACK_MS);

    let removeSnapshot: (() => void) | null = null;
    if (oldPage && !prefersReducedMotion()) {
      const snap = mountSnapshot(
        main,
        oldPage,
        oldScroll,
        direction === "forward" ? "push-out" : "pop-out",
        oldPaddingTop
      );
      if (snap) removeSnapshot = removeSnapshotAfter(snap, PUSH_FALLBACK_MS);
    }
    return () => {
      window.clearTimeout(enterTimer);
      main.removeEventListener("animationend", onEnd);
      clearEnter();
      removeSnapshot?.();
    };
  }, [pathname, direction]);

  useEffect(() => {
    document.dispatchEvent(new Event("lashkirja-dismiss-press"));
    bumpNavEpoch();
  }, [pathname, direction]);

  // AX-04, R2: every screen has its own document title ("Kuitit · LashKirja"),
  // which the route announcer reads. Kept against a later metadata write.
  const screenLabel = navEntry?.label ?? null;
  useEffect(() => {
    const title = screenLabel ? `${screenLabel} · LashKirja` : "LashKirja";
    document.title = title;
    if (typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => {
      if (document.title !== title) document.title = title;
    });
    observer.observe(document.head, { subtree: true, childList: true, characterData: true });
    return () => observer.disconnect();
  }, [screenLabel]);

  // AX-04, R2: after every navigation (push, pop, tab switch) focus moves to
  // the new screen's h1, as UIKit's screenChanged does. Not on the first
  // load, not when the page already focused a field, not under an overlay.
  useEffect(() => {
    if (direction === "none") return;
    let tries = 0;
    let raf = 0;
    const focusHeading = () => {
      const main = mainRef.current;
      if (!main) return;
      const active = document.activeElement;
      if (active instanceof HTMLElement && active !== document.body && main.contains(active)) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      const heading = main.querySelector<HTMLElement>(".app-page h1");
      if (!heading) {
        if (tries++ < 30) raf = requestAnimationFrame(focusHeading);
        return;
      }
      if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
      heading.focus({ preventScroll: true });
    };
    raf = requestAnimationFrame(focusHeading);
    return () => cancelAnimationFrame(raf);
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

  // The current stack entry keeps its full href (query included), so a tab
  // restore or a back to it lands on the same record and filters.
  useEffect(() => {
    updateCurrentHref(pathname, `${window.location.pathname}${window.location.search}`);
  });

  // C2 (IA-05..07): every in-content link is a push, whatever its URL depth
  // and whichever tab it lands in. The tab bar, the sidebar and the back
  // button arm their own direction; they are skipped here. Capture phase, so
  // this runs before the Link's own navigation.
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target instanceof Element ? event.target : null;
      const anchor = target?.closest<HTMLAnchorElement>("a[href]");
      if (!anchor || anchor.closest(".app-tab-bar, .app-sidebar")) return;
      if ((anchor.target && anchor.target !== "_self") || anchor.hasAttribute("download")) return;
      const path = landingPath(anchor.getAttribute("href") ?? "", window.location.href);
      if (!path || path === pathnameRef.current) return;
      armNavigation(path, "forward");
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  // iOS-style edge swipe back on drill-in pages. Starts only within 24px of
  // the left edge so horizontally scrollable content keeps working, tracks the
  // finger interruptibly with the previous screen waiting underneath, and
  // never leaves a resting transform on <main> (a retained transform
  // re-anchors position:fixed descendants).
  useEffect(() => {
    if (!canGoBack) return;
    const main = mainRef.current;
    if (!main) return;
    const header = main.parentElement?.querySelector<HTMLElement>(".app-header") ?? null;
    const tabBar = main.parentElement?.querySelector<HTMLElement>(".app-tab-bar") ?? null;
    // IA-28: leaving a detail for a screen that shows the tab bar, the bar
    // tracks the finger instead of appearing only after release.
    const parentPath = inAppPrevious(pathname) ?? back?.href ?? null;
    const barFollows = Boolean(isDetail && tabBar && parentPath && matchNav(parentPath)?.kind !== "detail");

    let startX = 0;
    let startY = 0;
    const tracker = new VelocityTracker();
    let dx = 0;
    let tracking = false;
    let decided = false;
    let under: HTMLElement | null = null;

    const clearInline = () => {
      main.style.transform = "";
      main.style.transition = "";
      main.style.opacity = "";
    };

    const clearBar = () => {
      if (!tabBar) return;
      tabBar.style.transform = "";
      tabBar.style.transition = "";
      tabBar.style.visibility = "";
    };

    const moveBar = (progress: number, transition = "none") => {
      if (!barFollows || !tabBar || prefersReducedMotion()) return;
      tabBar.style.transition = transition;
      tabBar.style.visibility = "visible";
      tabBar.style.transform = `translateY(${Math.round((1 - progress) * 100)}%)`;
    };

    const dropUnder = () => {
      under?.remove();
      under = null;
    };

    const onTouchStart = (event: TouchEvent) => {
      if (swipeLock.current) return;
      if (event.touches.length !== 1) return;
      const touch = event.touches[0];
      if (touch.clientX > EDGE_ZONE) return;
      // IA-27: a chip row that bleeds to the screen edge keeps its own
      // horizontal scroll only while it is scrolled away from its start. At
      // its start a rightward drag cannot scroll it, so the back swipe wins.
      const row = event.target instanceof Element ? event.target.closest<HTMLElement>(".overflow-x-auto") : null;
      if (row && row.scrollLeft > 0) return;
      tracking = true;
      decided = false;
      dx = 0;
      startX = touch.clientX;
      startY = touch.clientY;
      tracker.reset(touch.clientX);
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
        main.style.position = "relative";
        main.style.zIndex = "1";
        const parentPage = pageNodeFor(inAppPrevious(pathname));
        if (parentPage && !prefersReducedMotion()) {
          under = mountSnapshot(main, parentPage, recalledScroll(inAppPrevious(pathname) ?? ""), "swipe-under");
          if (under) under.style.transition = "none";
        }
      }
      event.preventDefault();
      tracker.add(touch.clientX);
      dx = Math.max(0, moveX);
      main.style.transform = `translateX(${dx}px)`;
      const progress = Math.min(1, dx / Math.max(main.offsetWidth, 1));
      if (under) under.style.transform = `translateX(${-28 * (1 - progress)}%)`;
      moveBar(progress);
    };

    const onTouchEnd = () => {
      if (!tracking) return;
      tracking = false;
      if (!decided) return;
      const commit = edgeSwipeCommits(dx, window.innerWidth, tracker.velocity());
      const reduceMotion = prefersReducedMotion();

      if (commit) {
        const go = () => {
          swipeLock.current = true;
          const landedUnder = under;
          under = null;
          // The next landing is already in place: no pop animation, just
          // swap the live page in and drop the preview underneath.
          swipeHandoffRef.current = () => {
            clearInline();
            clearBar();
            main.style.position = "";
            main.style.zIndex = "";
            landedUnder?.remove();
          };
          const navigate = () => {
            performInAppBack(pathname, router, back?.href);
          };
          if (reduceMotion) {
            clearInline();
            navigate();
            return;
          }
          const curve = "var(--ease-drawer)";
          main.style.transition = `transform ${EDGE_FINISH_MS}ms ${curve}`;
          main.style.transform = "translateX(100%)";
          moveBar(1, `transform ${EDGE_FINISH_MS}ms ${curve}`);
          if (landedUnder) {
            landedUnder.style.transition = `transform ${EDGE_FINISH_MS}ms ${curve}`;
            landedUnder.style.transform = "translateX(0)";
          } else {
            main.style.transition = `transform ${EDGE_FINISH_MS}ms ${curve}, opacity ${EDGE_FINISH_MS}ms ${curve}`;
            main.style.opacity = "0.4";
          }
          window.setTimeout(navigate, 190);
        };
        if (anyFormDirty()) {
          clearInline();
          clearBar();
          dropUnder();
          // The swipe set position/z-index on <main> for the page underneath.
          // Left in place, a cancelled prompt keeps <main> a stacking context,
          // and a sheet opened later is trapped under the header and banner.
          main.style.position = "";
          main.style.zIndex = "";
          requestLeave(go);
          return;
        }
        go();
      } else {
        const curve = "var(--ease-drawer)";
        main.style.transition = `transform ${EDGE_FINISH_MS}ms ${curve}`;
        main.style.transform = "translateX(0)";
        if (under) {
          under.style.transition = `transform ${EDGE_FINISH_MS}ms ${curve}`;
          under.style.transform = "translateX(-28%)";
        }
        moveBar(0, `transform ${EDGE_FINISH_MS}ms ${curve}`);
        const leaving = under;
        under = null;
        window.setTimeout(() => {
          clearInline();
          clearBar();
          main.style.position = "";
          main.style.zIndex = "";
          leaving?.remove();
        }, 220);
      }
    };

    // The swipe may start anywhere at the left edge, the header strip included.
    const surfaces = [main, header].filter((node): node is HTMLElement => node !== null);
    for (const surface of surfaces) {
      surface.addEventListener("touchstart", onTouchStart, { passive: true });
      surface.addEventListener("touchmove", onTouchMove, { passive: false });
      surface.addEventListener("touchend", onTouchEnd);
      surface.addEventListener("touchcancel", onTouchEnd);
    }
    return () => {
      for (const surface of surfaces) {
        surface.removeEventListener("touchstart", onTouchStart);
        surface.removeEventListener("touchmove", onTouchMove);
        surface.removeEventListener("touchend", onTouchEnd);
        surface.removeEventListener("touchcancel", onTouchEnd);
      }
      dropUnder();
      if (!swipeHandoffRef.current) {
        clearBar();
        clearInline();
        main.style.position = "";
        main.style.zIndex = "";
      }
      swipeLock.current = false;
    };
  }, [canGoBack, pathname, router, back?.href, isDetail]);

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

  // Onboarding state, once per signed-in user. The session source
  // (SessionProvider) already fetches and revalidates `/me`; this only
  // waits for a real `user` to exist before asking a second endpoint.
  const onboardingCheckedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!user) return;
    const uid = user.userId ?? "";
    if (onboardingCheckedFor.current === uid) return;
    onboardingCheckedFor.current = uid;
    if (readPageCache<boolean>(ONBOARDED_CACHE_KEY)) return;

    const controller = new AbortController();
    apiFetch("/api/onboarding", { signal: controller.signal })
      .then((res) => readJson<{ onboarded: boolean }>(res, ""))
      .then((data) => {
        if (!data) return;
        if (data.onboarded) {
          writePageCache(ONBOARDED_CACHE_KEY, true);
        } else if (isOnboardingSnoozed()) {
          setOnboardingSnoozed(true);
        } else {
          setShowOnboarding(true);
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, [user]);

  // Tab cache warm-up: web in idle time; mobile once, sequentially, 1.5 s
  // after the first screen (see warmTabCaches).
  useEffect(() => {
    if (IS_MOBILE_BUILD) {
      let timer: number | null = null;
      const unsubscribe = onFirstScreen(() => {
        timer = window.setTimeout(() => void warmTabCaches(true), 1500);
      });
      return () => {
        unsubscribe();
        if (timer !== null) window.clearTimeout(timer);
      };
    }
    let idleHandle: number | null = null;
    let timeoutHandle: number | null = null;
    if (typeof window.requestIdleCallback === "function") {
      idleHandle = window.requestIdleCallback(() => void warmTabCaches(false));
    } else {
      timeoutHandle = window.setTimeout(() => void warmTabCaches(false), 1500);
    }
    return () => {
      if (idleHandle !== null && typeof window.cancelIdleCallback === "function") {
        window.cancelIdleCallback(idleHandle);
      }
      if (timeoutHandle !== null) window.clearTimeout(timeoutHandle);
    };
  }, []);

  // Mobile only: the shell is one of the two possible "first real screen"s
  // (the other is LoginForm). The native splash hides once the page shows
  // real content (no skeleton left) or after 350 ms at most (SHELL-08), so
  // the splash fade never overlaps an empty frame.
  const splashWaitStart = useRef<number | null>(null);
  useEffect(() => {
    if (!IS_MOBILE_BUILD || sessionStatus === "signed-out") return;
    if (splashWaitStart.current === null) splashWaitStart.current = performance.now();
    const started = splashWaitStart.current;
    let raf = 0;
    let stopped = false;
    const contentReady = () => {
      const main = mainRef.current;
      if (!main || !main.firstElementChild || main.firstElementChild.childElementCount === 0) return false;
      return !main.querySelector('.skeleton, .animate-pulse, [aria-busy="true"]');
    };
    const tick = () => {
      if (stopped) return;
      if (contentReady() || performance.now() - started >= SPLASH_MAX_WAIT_MS) {
        raf = requestAnimationFrame(() => {
          raf = requestAnimationFrame(() => markFirstScreen());
        });
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
    };
  }, [sessionStatus]);

  const showProfile = profileOpenOn === pathname;
  const chatOpen = chatOpenOn === pathname;
  const liveInitial = (user?.firstName?.trim()?.[0] || user?.email?.trim()?.[0] || "").toUpperCase();
  const storedInitial = useSyncExternalStore(noSubscribe, readStoredInitial, () => "");
  const initials = liveInitial || (sessionStatus === "signed-out" ? "" : storedInitial);

  useEffect(() => {
    if (liveInitial) writeStoredInitial(liveInitial);
    else if (sessionStatus === "signed-out") writeStoredInitial(null);
  }, [liveInitial, sessionStatus]);

  const addOpen = addOpenOn === pathname;

  function goToRoot(event: { preventDefault: () => void; currentTarget?: EventTarget | null }, tab: NavEntry) {
    setAddOpenOn(null);
    setProfileOpenOn(null);
    handleTabClick(event, tab, {
      pathname,
      activeTab: activeTabId,
      main: mainRef.current,
      router,
      refresh: () => setTabEpoch((value) => value + 1),
    });
  }

  /** Push a screen with the forward (push) transition. */
  function goForward(href: string) {
    armNavigation(href.split("?")[0], "forward");
    router.push(href);
  }

  // Lisää sheet: "Ota kuva" opens the camera and "Tuo tiliote" the document
  // picker straight from the tap (SHELL-02 / OWN-04, SHELL-30). The picked
  // files wait in lib/pending-capture for the receiving screen. Web: the tap
  // is the user gesture a hidden file input needs.
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const statementInputRef = useRef<HTMLInputElement>(null);

  function handOver(kind: PendingCaptureKind, files: File[]) {
    if (files.length === 0) return;
    stashPendingCapture(kind, files);
    goForward(PENDING_CAPTURE_ROUTES[kind]);
  }

  async function pickFromSheet(kind: PendingCaptureKind, fromGesture: boolean) {
    const fallbackRoute = kind === "receipt" ? "/kuitit/uusi" : "/pankki/tapahtumat";
    if (isNativeShell()) {
      const picked = kind === "receipt" ? await captureWithCamera() : await chooseDocuments(STATEMENT_FILE_TYPES);
      if (picked.kind === "files") handOver(kind, picked.files);
      else if (picked.kind === "denied") showToast({ tone: "error", text: picked.message });
      else if (picked.kind === "unavailable") goForward(fallbackRoute);
      // "cancel": stay where the user was.
      return;
    }
    const input = kind === "receipt" ? cameraInputRef.current : statementInputRef.current;
    if (fromGesture && input) {
      input.click();
      return;
    }
    goForward(fallbackRoute);
  }

  function startPick(kind: PendingCaptureKind) {
    setAddOpenOn(null);
    if (anyFormDirty()) {
      requestLeave(() => void pickFromSheet(kind, false));
      return;
    }
    void pickFromSheet(kind, true);
  }

  function renderTab(item: NavEntry) {
    const active = activeTabId === item.id;
    return (
      <Link
        key={item.id}
        href={item.path}
        prefetch
        onClick={(event) => goToRoot(event, item)}
        className={`flex min-w-0 flex-1 flex-col items-center justify-center gap-1 touch-target transition-colors active-press ${
          active ? "text-accent" : "text-ink-2"
        }`}
        aria-current={active ? "page" : undefined}
      >
        <Icon icon={rootIcon(item.id)} size="tab" />
        <span
          className={`max-w-full truncate text-tab leading-tight ${active ? "font-semibold" : "font-medium"}`}
        >
          {item.label}
        </span>
      </Link>
    );
  }

  const backName = backLabel ?? back?.label ?? null;

  return (
    <AppLock>
    {sessionStatus !== "signed-out" && (
      <aside className="app-sidebar" aria-hidden={false}>
        <p className="flex items-center gap-2.5 px-5 pb-4 pt-5 text-headline font-bold tracking-[-0.01em] text-ink">
          <AppMark />
          LashKirja
        </p>
        <div className="px-3 pb-3">
          <button
            type="button"
            onClick={() => setAddOpenOn(pathname)}
            aria-haspopup="dialog"
            aria-expanded={addOpen}
            className="flex min-h-12 w-full items-center justify-center gap-2 rounded-card bg-ink text-body font-semibold text-canvas active-press"
          >
            <Icon icon={Plus} strokeWidth={2} />
            Lisää
          </button>
        </div>
        <nav aria-label="Päävalikko" className="flex flex-1 flex-col gap-0.5 px-3">
          {tabRoots().map((item) => {
            const active = activeTabId === item.id;
            return (
              <Link
                key={item.id}
                href={item.path}
                prefetch
                onClick={(event) => goToRoot(event, item)}
                aria-current={active ? "page" : undefined}
                className={`flex min-h-12 items-center gap-3 rounded-card px-3 text-left text-body active-press ${
                  active ? "bg-accent-soft font-semibold text-accent" : "font-medium text-ink"
                }`}
              >
                <Icon icon={rootIcon(item.id)} className={active ? "text-accent" : "text-ink-2"} />
                <span className="truncate">{item.label}</span>
              </Link>
            );
          })}
        </nav>
        <div className="mt-auto px-3 pb-4">
          <Link
            href={avatarRoot().path}
            prefetch
            onClick={(event) => goToRoot(event, avatarRoot())}
            aria-current={activeTabId === "asetukset" ? "page" : undefined}
            className={`flex min-h-12 w-full items-center gap-3 rounded-card px-3 text-left text-body active-press ${
              activeTabId === "asetukset" ? "bg-accent-soft font-semibold text-accent" : "font-medium text-ink"
            }`}
          >
            <Icon
              icon={Settings}
              className={activeTabId === "asetukset" ? "text-accent" : "text-ink-2"}
            />
            Asetukset
          </Link>
        </div>
      </aside>
    )}
    <div className="app-frame" data-tabs={isDetail ? "hidden" : undefined}>
      <UnsavedChangesHost />
      <header
        ref={headerRef}
        className="app-header relative z-40 bg-canvas"
        onContextMenu={(event) => event.preventDefault()}
      >
        {/* The collapsed inline title (IA-14). aria-hidden: the h1 is the name. */}
        <p ref={inlineTitleRef} className="app-header-title" aria-hidden />
        {/* px-3 + the 4px inset of each 36px circle inside its 44px hit box puts the avatar's outer
            edge on the same 16px line as the cards below, and the back chevron's stroke on the
            page title's 20px line. */}
        <div className="app-header-row mx-auto min-h-14 w-full max-w-lg px-3 md:max-w-3xl">
          <div className="flex h-11 min-w-11 items-center justify-self-start">
            {canGoBack && (
              <button
                type="button"
                onClick={goBack}
                aria-label={backName ? `Takaisin: ${backName}` : "Takaisin"}
                className="flex h-11 max-w-full items-center gap-0.5 pr-2 text-accent active-press"
              >
                <Icon icon={ChevronLeft} size="tab" strokeWidth={2} />
                {backName && <span className="truncate text-body font-medium">{backName}</span>}
              </button>
            )}
          </div>

          {sessionStatus !== "signed-out" ? (
            <div className="flex items-center gap-1 justify-self-end">
              <button
                type="button"
                onClick={() => setChatOpenOn(pathname)}
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
                <span className="flex h-9 w-9 items-center justify-center rounded-full border border-accent-soft bg-accent-soft text-body font-semibold text-accent">
                  {initials || <Icon icon={User} />}
                </span>
              </button>
            </div>
          ) : (
            <div className="w-11" aria-hidden />
          )}
        </div>
      </header>

      <ConnectivityBanner />

      {/* One persistent scroll container (SHELL-06/07): only the inner page
          wrapper is keyed, so the scroll position and the element survive a
          navigation and nothing fades on a tab switch. */}
      <main
        ref={mainRef}
        className="app-main mx-auto w-full max-w-lg flex-1 md:max-w-3xl"
      >
        <div key={pathname} ref={setPageNode} className="app-page">
          {/* Page fetches start in parallel with the session check -- there
              is no "checking session" gate. Only an actual sign-out (a
              confirmed 401, or mobile finding no stored token) blanks this;
              SessionProvider is already navigating away by then. */}
          {onboardingSnoozed && !showOnboarding && pathname === "/dashboard" && (
            <OnboardingResumeCard onResume={() => setShowOnboarding(true)} />
          )}
          {sessionStatus === "signed-out" ? null : children}
        </div>
      </main>

      {sessionStatus !== "signed-out" && (
        <>
          <AiChatDrawer open={chatOpen} onClose={() => setChatOpenOn(null)} />
          <OnboardingChat
            isOpen={showOnboarding}
            onComplete={() => {
              writePageCache(ONBOARDED_CACHE_KEY, true);
              setOnboardingSnoozed(false);
              setShowOnboarding(false);
            }}
            onSnooze={() => {
              setOnboardingSnoozed(true);
              setShowOnboarding(false);
            }}
          />

          {/* Stays mounted on detail routes and slides away (SHELL-13). */}
          <nav
            className="app-tab-bar z-50 border-t border-line bg-surface"
            aria-label="Päävalikko"
            aria-hidden={isDetail || undefined}
            inert={isDetail}
            onContextMenu={(event) => event.preventDefault()}
          >
            <div className="mx-auto flex h-[var(--app-tab-height)] max-w-lg items-stretch">
              {tabRoots().slice(0, 2).map((item) => renderTab(item))}
              {/* The primary control (OWN-03): 60 px, raised above the bar. */}
              <div className="flex w-[76px] flex-none items-center justify-center">
                <button
                  type="button"
                  onClick={() => {
                    void hapticImpact("light");
                    setAddOpenOn(pathname);
                  }}
                  aria-label="Lisää"
                  aria-haspopup="dialog"
                  aria-expanded={addOpen}
                  className="tab-plus flex h-[60px] w-[60px] -translate-y-2.5 items-center justify-center rounded-full bg-ink text-canvas"
                >
                  <Icon icon={Plus} size="hero" strokeWidth={2} />
                </button>
              </div>
              {tabRoots().slice(2).map((item) => renderTab(item))}
            </div>
          </nav>

          <ToastHost />

          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            tabIndex={-1}
            aria-hidden
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = "";
              handOver("receipt", files);
            }}
          />
          <input
            ref={statementInputRef}
            type="file"
            accept={STATEMENT_ACCEPT}
            className="hidden"
            tabIndex={-1}
            aria-hidden
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = "";
              handOver("statement", files);
            }}
          />

          <BottomSheet
            isOpen={addOpen}
            onClose={() => setAddOpenOn(null)}
            title="Lisää"
            labelledBy="add-sheet-title"
            heightClass="max-h-[70dvh]"
            dirty={false}
          >
            <div className="space-y-3 px-4 py-2 sheet-safe-bottom">
              <button
                type="button"
                onClick={() => startPick("receipt")}
                className="flex w-full items-center gap-3 rounded-card bg-ink px-4 py-4 text-left text-canvas active-press"
              >
                <Icon icon={Camera} size="tab" />
                <span className="min-w-0">
                  <span className="block text-base font-semibold">Ota kuva</span>
                  <span className="block text-caption text-canvas/70">Kuitti luetaan automaattisesti</span>
                </span>
              </button>
              <div className="overflow-hidden rounded-card border border-line bg-surface divide-y divide-line">
                <button
                  type="button"
                  onClick={() => startPick("statement")}
                  className="press-row flex w-full items-center gap-3 px-4 py-3.5 text-left touch-target"
                >
                  <IconTile>
                    <Icon icon={FileUp} />
                  </IconTile>
                  <span className="min-w-0 flex-1">
                    <span className="block text-body font-medium text-ink">Tuo tiliote</span>
                    <span className="mt-0.5 block truncate text-caption text-ink-2">CSV, XLSX, camt tai PDF</span>
                  </span>
                </button>
                {(
                  [
                    { href: "/laskut/uusi", label: "Uusi myyntilasku", icon: FilePlus },
                    { href: "/asetukset/sahkoposti", label: "Hae sähköpostista", icon: Mail },
                  ] as const satisfies readonly { href: string; label: string; icon: LucideIcon }[]
                ).map((row) => (
                  <button
                    key={row.href}
                    type="button"
                    onClick={() => {
                      setAddOpenOn(null);
                      requestLeave(() => goForward(row.href));
                    }}
                    className="press-row flex w-full items-center gap-3 px-4 py-3.5 text-left touch-target"
                  >
                    <IconTile>
                      <Icon icon={row.icon} />
                    </IconTile>
                    <span className="min-w-0 flex-1">
                      <span className="block text-body font-medium text-ink">{row.label}</span>
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
            dirty={false}
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
                  onClick={(event) => goToRoot(event, avatarRoot())}
                  aria-current={activeTabId === "asetukset" ? "page" : undefined}
                  className="press-row w-full flex items-center gap-3 px-4 py-3.5 text-left touch-target"
                >
                  <IconTile>
                    <Icon icon={Settings} />
                  </IconTile>
                  <span className="text-body font-medium text-ink">Asetukset</span>
                </button>
                <button
                  type="button"
                  onClick={requestSignOut}
                  disabled={signingOut}
                  className="press-row w-full flex items-center gap-3 px-4 py-3.5 text-left disabled:opacity-60 touch-target"
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
                  <span className="text-body font-medium text-danger">
                    {signingOut ? "Kirjaudutaan ulos…" : "Kirjaudu ulos"}
                  </span>
                </button>
              </div>
            </div>
          </BottomSheet>

          {confirmDialog}
        </>
      )}
    </div>
    </AppLock>
  );
}
