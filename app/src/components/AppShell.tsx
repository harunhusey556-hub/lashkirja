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
  MessageCircle,
  Plus,
  Settings,
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

import { PageHeaderActionsContext } from "@/components/PageHeaderActions";

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
import { hapticImpact, hapticSelection } from "@/lib/haptics";
import { EDGE_ZONE, edgeSwipeCommits, edgeReleaseTiming, VelocityTracker } from "@/lib/gesture";
import { anyFormDirty, requestLeave } from "@/lib/form-guard";
import { keepPendingTab, PENDING_TAB_TIMEOUT_MS, type PendingTab } from "@/lib/pending-tab";
import { UnsavedChangesHost } from "@/components/UnsavedChangesHost";
import { captureWithCamera, chooseDocuments, isNativeShell } from "@/lib/native-pick";
import {
  PENDING_CAPTURE_ROUTES,
  STATEMENT_ACCEPT,
  STATEMENT_FILE_TYPES,
  stashPendingCapture,
  type PendingCaptureKind,
} from "@/lib/pending-capture";
import { CAPTURE_REQUEST_EVENT, STATEMENT_IMPORT_REQUEST_EVENT, captureReceiptHref, type CaptureRequest } from "@/lib/capture-request";
import { refreshSharedProfile } from "@/app/asetukset/useProfile";
import { showToast } from "@/lib/toast";
import {
  forgetScroll,
  keepPageNode,
  mountSnapshot,
  navDurationMs,
  navEasing,
  pageNodeFor,
  playNavTransition,
  prefersReducedMotion,
  recalledScroll,
  rememberScroll,
  UNDER_SHIFT,
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
/** Top-level screens that draw their title and actions inside the page, with no header row. */
const INLINE_HEADER_ROOTS = ["/dashboard", "/kirjanpito", "/laskut", "/raportit", "/asetukset"];

const isInlineHeaderPath = (path: string) => INLINE_HEADER_ROOTS.includes(path.split("?")[0]);

/** The header row as it was last drawn, and where, for the next navigation. */
type HeaderRowShot = { node: HTMLElement; top: number; left: number; width: number; height: number };

/** A copy of the visible header row and its frame position (transforms ignored). */
function shootHeaderRow(frame: HTMLElement | null): HeaderRowShot | null {
  const header = frame?.querySelector<HTMLElement>(".app-header");
  const row = header?.querySelector<HTMLElement>(".app-header-row");
  if (!header || !row || row.offsetParent === null || row.offsetHeight === 0) return null;
  return {
    node: row.cloneNode(true) as HTMLElement,
    top: header.offsetTop + row.offsetTop,
    left: header.offsetLeft + row.offsetLeft,
    width: row.offsetWidth,
    height: row.offsetHeight,
  };
}

/**
 * The header row through a push or pop. By the time this runs the row
 * already shows the new screen, so the old one would pop: here the old row
 * (the copy taken after the last commit) leaves and the new one arrives, as
 * on iOS. Root to detail: the row slides in. Detail to root: the old row
 * rides out to the right. Detail to detail: old and new cross-fade with a
 * short shift. A root has no row, so the old page's <main> started higher or
 * lower; `oldTop` puts the outgoing page back where it was.
 */
function headerRowHandoff(main: HTMLElement, from: string, to: string, kind: "push" | "pop", previous: HeaderRowShot | null) {
  const fromInline = isInlineHeaderPath(from);
  const toInline = isInlineHeaderPath(to);
  if (fromInline && toInline) return null;
  const frame = main.parentElement;
  const row = frame?.querySelector<HTMLElement>(".app-header .app-header-row") ?? null;
  if (!frame || !row || typeof row.animate !== "function") return null;
  let oldTop: number | undefined;
  if (fromInline !== toInline) {
    const now = frame.dataset.inlineHeader;
    if (fromInline) frame.dataset.inlineHeader = "true";
    else delete frame.dataset.inlineHeader;
    oldTop = main.offsetTop;
    if (now === undefined) delete frame.dataset.inlineHeader;
    else frame.dataset.inlineHeader = now;
  }

  return {
    oldTop,
    play(): { animations: Animation[]; cleanup: () => void } {
      const timing = { duration: navDurationMs(), easing: navEasing() };
      const animations: Animation[] = [];
      let ghost: HTMLElement | null = null;
      const rowBackground = row.style.backgroundColor;
      // Root titles live in <main> higher than a drill-in header. The
      // incoming row must carry an opaque surface, otherwise the old title
      // remains visible through its transparent pixels during the slide.
      row.style.backgroundColor = getComputedStyle(frame).backgroundColor;
      // The old row leaves (a detail had one).
      if (!fromInline && previous) {
        ghost = previous.node;
        ghost.setAttribute("aria-hidden", "true");
        ghost.inert = true;
        Object.assign(ghost.style, {
          position: "absolute",
          top: `${previous.top}px`,
          left: `${previous.left}px`,
          width: `${previous.width}px`,
          height: `${previous.height}px`,
          margin: "0",
          display: "grid",
          zIndex: "45",
          pointerEvents: "none",
          backgroundColor: getComputedStyle(frame).backgroundColor,
        });
        frame.appendChild(ghost);
        const out = toInline ? "translate3d(100%, 0, 0)" : kind === "push" ? "translate3d(-24%, 0, 0)" : "translate3d(24%, 0, 0)";
        const leaving = ghost.animate(
          [
            { transform: "translate3d(0, 0, 0)", opacity: 1 },
            { transform: out, opacity: toInline ? 1 : 0 },
          ],
          { ...timing, duration: toInline ? timing.duration : timing.duration * 0.6, fill: "forwards" }
        );
        const drop = () => ghost?.remove();
        leaving.onfinish = drop;
        animations.push(leaving);
      }
      // The new row arrives (the new screen is a detail).
      if (!toInline) {
        const from = fromInline ? "translate3d(100%, 0, 0)" : kind === "push" ? "translate3d(24%, 0, 0)" : "translate3d(-24%, 0, 0)";
        animations.push(
          row.animate(
            [
              { transform: from, opacity: fromInline ? 1 : 0 },
              { transform: "translate3d(0, 0, 0)", opacity: 1 },
            ],
            timing
          )
        );
      }
      for (const animation of animations) { animation.pause(); animation.currentTime = 0; }
      Promise.all(animations.map((animation) => animation.finished)).then(() => { row.style.backgroundColor = rowBackground; }, () => {});
      return { animations, cleanup: () => {
        animations.forEach((animation) => animation.cancel());
        ghost?.remove();
        row.style.backgroundColor = rowBackground;
      } };
    },
  };
}

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

/** Mirrors .tab-capsule's --tab-pad in globals.css. */
const TAB_CAPSULE_PAD = 4;
/** A press becomes a slide once the finger travels this far (px). */
const TAB_DRAG_SLOP = 6;

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
  const lastHeaderRow = useRef<HeaderRowShot | null>(null);
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
  const landedTabId = typeof window === "undefined" ? rootIdOf(pathname) : tabAfterLanding(pathname, direction);
  // OWN-19: the tapped tab lights up on the tap, as on iOS, not only once the
  // new screen has loaded. Dropped on any path change (adjusted during render,
  // like navFrame above) and after a timeout if the push never lands.
  const [pendingTab, setPendingTab] = useState<PendingTab | null>(null);
  if (pendingTab && keepPendingTab(pendingTab, pathname) === null) setPendingTab(null);
  const livePending = keepPendingTab(pendingTab, pathname);
  const activeTabId = livePending ? livePending.id : landedTabId;
  useEffect(() => {
    if (!pendingTab) return;
    const timer = window.setTimeout(() => setPendingTab(null), PENDING_TAB_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [pendingTab]);
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
    // A tab lands where it can at once: re-applying the offset while the new
    // page streams in moved it under the fade, which read as a tremble.
    pendingScrollRef.current =
      direction !== "tab" && main.scrollTop < target - 1 ? { top: target, until: performance.now() + 2000 } : null;

    const handoff = swipeHandoffRef.current;
    swipeHandoffRef.current = null;
    if (handoff) {
      handoff();
      return;
    }

    // Full push/pop motion uses prepared compositor layers.
    // Tab switches fade the new page in without blending outgoing text.
    // Asetukset, opened from the avatar, rises like an iOS account sheet.
    if (direction !== "forward" && direction !== "back" && direction !== "tab") return;
    const avatarPath = avatarRoot().path;
    const presents = direction === "tab" && pathname === avatarPath && rootIdOf(from) !== rootIdOf(avatarPath);
    const kind = direction === "forward" ? "push" : direction === "back" ? "pop" : presents ? "present" : "tab";
    const headerMotion =
      !prefersReducedMotion() && (kind === "push" || kind === "pop") ? headerRowHandoff(main, from, pathname, kind, lastHeaderRow.current) : null;
    const rowMotion = headerMotion?.play();
    const stopPage = playNavTransition({
      main,
      oldPage,
      oldScroll,
      oldPaddingTop,
      kind,
      newPage: pageNodeRef.current,
      oldTop: headerMotion?.oldTop,
      companionAnimations: rowMotion?.animations,
    });
    return () => {
      stopPage();
      rowMotion?.cleanup();
    };
  }, [pathname, direction]);

  useEffect(() => {
    document.dispatchEvent(new Event("lashkirja-dismiss-press"));
    bumpNavEpoch();
  }, [pathname, direction]);

  // After every commit (declared after the navigation effect, so that one
  // still reads the previous screen's copy): the header row as drawn now.
  useLayoutEffect(() => {
    lastHeaderRow.current = shootHeaderRow(mainRef.current?.parentElement ?? null);
  });

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
      // Focus paints the heading outline; keep it out of the moving frames.
      if (main.dataset.navMoving) {
        if (tries++ < 60) raf = requestAnimationFrame(focusHeading);
        return;
      }
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
    let width = 1;
    let moveRaf = 0;
    let cancelSettlement: (() => void) | null = null;

    // Back to a root that has no header row (Kirjanpito, Koti, ...): the row
    // leaves with the page instead of vanishing after the swipe.
    const headerRow = header?.querySelector<HTMLElement>(".app-header-row") ?? null;
    const rowLeaves = Boolean(headerRow && parentPath && INLINE_HEADER_ROOTS.includes(parentPath.split("?")[0]));
    const moveRow = (progress: number, transition = "none") => {
      if (!rowLeaves || !headerRow) return;
      headerRow.style.transition = transition;
      headerRow.style.transform = `translateX(${progress * 100}%)`;
      headerRow.style.opacity = String(Math.max(0, 1 - progress * 1.6));
    };
    const clearRow = () => {
      if (!headerRow) return;
      headerRow.style.transition = "";
      headerRow.style.transform = "";
      headerRow.style.opacity = "";
    };
    /** Where <main> starts once the header row is gone: measured, not guessed. */
    const rootMainTop = () => {
      const frame = main.parentElement;
      if (!rowLeaves || !frame) return undefined;
      const had = frame.dataset.inlineHeader;
      frame.dataset.inlineHeader = "true";
      const top = main.offsetTop;
      if (had === undefined) delete frame.dataset.inlineHeader;
      else frame.dataset.inlineHeader = had;
      return top;
    };

    // The strip above <main> (behind the header row) belongs to the sliding
    // page too: without it the frame's own background stayed put there.
    let cap: HTMLElement | null = null;
    const mountCap = () => {
      const frame = main.parentElement;
      if (!frame || main.offsetTop <= 0) return;
      const look = getComputedStyle(frame);
      cap = document.createElement("div");
      cap.className = "swipe-cap";
      cap.setAttribute("aria-hidden", "true");
      cap.style.height = `${main.offsetTop}px`;
      cap.style.width = `${main.offsetWidth}px`;
      cap.style.left = `${main.offsetLeft}px`;
      cap.style.backgroundColor = look.backgroundColor;
      cap.style.backgroundImage = look.backgroundImage;
      cap.style.backgroundSize = `${frame.offsetWidth}px ${frame.offsetHeight}px`;
      frame.insertBefore(cap, main);
    };
    const moveCap = (transform: string, transition = "none") => {
      if (!cap) return;
      cap.style.transition = transition;
      cap.style.transform = transform;
    };
    const dropCap = () => {
      cap?.remove();
      cap = null;
    };

    const clearInline = () => {
      main.style.transform = "";
      main.style.transition = "";
      main.style.opacity = "";
      main.style.willChange = "";
      delete main.dataset.swiping;
      clearRow();
      dropCap();
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
      // Mid push/pop, WAAPI owns <main>'s transform and the parent page node
      // is inside the outgoing snapshot; a swipe would fight both.
      if (main.dataset.navMoving) return;
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
      width = Math.max(main.clientWidth, 1);
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
        // An opaque, shadowed page while it slides: <main> is transparent in
        // the stitch design, and the parent page underneath showed through.
        main.dataset.swiping = "true";
        main.style.willChange = "transform";
        mountCap();
        const parentPage = pageNodeFor(inAppPrevious(pathname));
        if (parentPage && !prefersReducedMotion()) {
          under = mountSnapshot(main, parentPage, recalledScroll(inAppPrevious(pathname) ?? ""), "swipe-under", undefined, rootMainTop());
          if (under) under.style.transition = "none";
        }
      }
      event.preventDefault();
      tracker.add(touch.clientX);
      dx = Math.max(0, moveX);
      dx = Math.min(width, dx);
      if (!moveRaf) moveRaf = requestAnimationFrame(drawDrag);
    };

    const drawDrag = () => {
      moveRaf = 0;
      const progress = dx / width;
      main.style.transform = `translate3d(${dx}px, 0, 0)`;
      moveCap(`translate3d(${dx}px, 0, 0)`);
      if (under) under.style.transform = `translate3d(${-30 * (1 - progress)}%, 0, 0)`;
      moveBar(progress);
      moveRow(progress);
    };

    const resetSwipe = () => {
      clearInline();
      clearBar();
      dropUnder();
      main.style.position = "";
      main.style.zIndex = "";
      swipeLock.current = false;
    };

    const onTouchEnd = (event: TouchEvent) => {
      if (!tracking) return;
      tracking = false;
      if (!decided) return;
      cancelAnimationFrame(moveRaf);
      drawDrag();
      const velocity = tracker.velocity();
      // OS interruptions must return to this page, never approve a back.
      const commit = event.type !== "touchcancel" && edgeSwipeCommits(dx, width, velocity);
      if (commit && anyFormDirty()) {
        resetSwipe();
        requestLeave(() => performInAppBack(pathname, router, back?.href));
        return;
      }
      const navigate = () => performInAppBack(pathname, router, back?.href);
      if (prefersReducedMotion()) {
        resetSwipe();
        if (commit) navigate();
        return;
      }
      swipeLock.current = true;
      const timing = { ...edgeReleaseTiming(dx, width, velocity, commit), fill: "both" as const };
      const animations: Animation[] = [];
      const animateTo = (node: HTMLElement | null, target: Keyframe) => {
        if (!node) return;
        const style = getComputedStyle(node);
        animations.push(node.animate([
          { transform: style.transform, opacity: style.opacity }, target,
        ], timing));
      };
      animateTo(main, { transform: commit ? "translate3d(100%, 0, 0)" : "translate3d(0, 0, 0)" });
      animateTo(cap, { transform: commit ? "translate3d(100%, 0, 0)" : "translate3d(0, 0, 0)" });
      animateTo(under, { transform: commit ? "translate3d(0, 0, 0)" : `translate3d(${UNDER_SHIFT}, 0, 0)` });
      if (barFollows) animateTo(tabBar, { transform: commit ? "translateY(0)" : "translateY(100%)" });
      if (rowLeaves) animateTo(headerRow, { transform: commit ? "translateX(100%)" : "translateX(0)", opacity: commit ? 0 : 1 });
      const startedAt = document.timeline.currentTime;
      for (const animation of animations) if (typeof startedAt === "number") animation.startTime = startedAt;
      let done = false;
      let fallback = 0;
      const cancel = () => {
        if (done) return;
        done = true;
        window.clearTimeout(fallback);
        animations.forEach((animation) => animation.cancel());
      };
      cancelSettlement = cancel;
      const finish = () => {
        if (done) return;
        if (commit) {
          // Preserve the settled visual until React lands, even on a slow
          // route. Removing fill before landing would flash the old page.
          main.style.transform = "translate3d(100%, 0, 0)";
          moveCap("translate3d(100%, 0, 0)");
          if (under) under.style.transform = "translate3d(0, 0, 0)";
          moveBar(1);
          moveRow(1);
          const landedUnder = under;
          under = null;
          swipeHandoffRef.current = () => {
            resetSwipe();
            landedUnder?.remove();
          };
          cancel();
          navigate();
        } else {
          cancel();
          resetSwipe();
        }
      };
      // Land on the actual compositor finish, not a guessed 190 ms timer.
      Promise.all(animations.map((animation) => animation.finished)).then(finish, () => {});
      fallback = window.setTimeout(finish, timing.duration + 500);
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
      cancelAnimationFrame(moveRaf);
      cancelSettlement?.();
      dropUnder();
      dropCap();
      clearRow();
      clearBar();
      delete main.dataset.swiping;
      main.style.position = "";
      // A push/pop started by the landing's layout effect runs before this
      // cleanup; clearing its z-index here put the old page over the new one.
      if (!swipeHandoffRef.current && !main.dataset.navMoving) {
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
        // Only the nearest real scroller moves. scrollIntoView also scrolled
        // the clipped frame and drawer, which then stayed shifted up with the
        // header gone once the keyboard settled.
        let scroller = active.parentElement;
        while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
        if (!scroller) return;
        const box = scroller.getBoundingClientRect();
        const field = active.getBoundingClientRect();
        if (field.bottom > box.bottom) scroller.scrollTop += field.bottom - box.bottom + 8;
        else if (field.top < box.top) scroller.scrollTop -= box.top - field.top + 8;
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
    if (tab.id !== landedTabId && !anyFormDirty()) setPendingTab({ id: tab.id, from: pathname });
    // The tab the screen is on, not the pending highlight: a release already
    // marks the new tab pending, and its click must still open that tab.
    handleTabClick(event, tab, {
      pathname,
      activeTab: landedTabId,
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

  // Lisää sheet: "Kuvaa kuitti" opens the camera and "Tuo tiliote" the document
  // picker straight from the tap (SHELL-02 / OWN-04, SHELL-30). The picked
  // files wait in lib/pending-capture for the receiving screen. Web: the tap
  // is the user gesture a hidden file input needs.
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const statementInputRef = useRef<HTMLInputElement>(null);
  const captureRequestRef = useRef<CaptureRequest | undefined>(undefined);

  function handOver(kind: PendingCaptureKind, files: File[]) {
    if (files.length === 0) return;
    stashPendingCapture(kind, files);
    const href = kind === "receipt" ? captureReceiptHref(captureRequestRef.current) : PENDING_CAPTURE_ROUTES[kind];
    captureRequestRef.current = undefined;
    goForward(href);
  }

  async function pickFromSheet(kind: PendingCaptureKind, fromGesture: boolean) {
    const fallbackRoute = kind === "receipt" ? captureReceiptHref(captureRequestRef.current, false) : "/pankki/tapahtumat";
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

  function startPick(kind: PendingCaptureKind, request?: CaptureRequest) {
    captureRequestRef.current = kind === "receipt" ? request : undefined;
    setAddOpenOn(null);
    if (anyFormDirty()) {
      requestLeave(() => void pickFromSheet(kind, false));
      return;
    }
    void pickFromSheet(kind, true);
  }

  // TF-06 / FP-10: "Ota ensimmäinen kuva" and "Lisää kuva" on a task open the
  // same camera as the Lisää sheet (lib/capture-request.ts). Synchronous, so
  // the web file input still runs inside the tap's user gesture.
  const startPickRef = useRef(startPick);
  useEffect(() => {
    startPickRef.current = startPick;
  });
  useEffect(() => {
    const onRequest = (event: Event) => startPickRef.current("receipt", (event as CustomEvent<CaptureRequest>).detail);
    // F24: "Tuo tiliote" on Koti and in the month close picks the file from the tap too.
    const onImport = () => startPickRef.current("statement");
    window.addEventListener(CAPTURE_REQUEST_EVENT, onRequest);
    window.addEventListener(STATEMENT_IMPORT_REQUEST_EVENT, onImport);
    return () => {
      window.removeEventListener(CAPTURE_REQUEST_EVENT, onRequest);
      window.removeEventListener(STATEMENT_IMPORT_REQUEST_EVENT, onImport);
    };
  }, []);

  const activeTabIndex = tabRoots().findIndex((item) => item.id === activeTabId);

  // iOS 26 tab capsule: a press grows the lens under the finger, and a held
  // press slides it from tab to tab (a selection tick per tab); letting go
  // opens the tab under the finger. A plain tap still clicks the tab's link.
  const capsuleRef = useRef<HTMLDivElement>(null);
  const tabPress = useRef<{ pointerId: number; startX: number; index: number; dragging: boolean } | null>(null);
  const swallowTabClick = useRef(false);

  function tabSlot(clientX: number) {
    const capsule = capsuleRef.current;
    if (!capsule) return null;
    const rect = capsule.getBoundingClientRect();
    const count = tabRoots().length;
    const width = (rect.width - 2 * TAB_CAPSULE_PAD) / count;
    const x = clientX - rect.left - TAB_CAPSULE_PAD;
    const index = Math.min(count - 1, Math.max(0, Math.floor(x / width)));
    // The lens centres on the finger, but never leaves the track.
    const offset = Math.min((count - 1) * width, Math.max(0, x - width / 2));
    return { capsule, index, offset };
  }

  function onTabPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (!event.isPrimary || event.button !== 0) return;
    const slot = tabSlot(event.clientX);
    if (!slot) return;
    tabPress.current = { pointerId: event.pointerId, startX: event.clientX, index: slot.index, dragging: false };
    // A press lands the lens on the pressed tab; it follows the finger only once it moves.
    const width = (slot.capsule.getBoundingClientRect().width - 2 * TAB_CAPSULE_PAD) / tabRoots().length;
    slot.capsule.style.setProperty("--tab-drag-x", `${slot.index * width}px`);
    slot.capsule.dataset.pressing = "";
  }

  function onTabPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const press = tabPress.current;
    if (!press || press.pointerId !== event.pointerId) return;
    if (!press.dragging) {
      if (Math.abs(event.clientX - press.startX) < TAB_DRAG_SLOP) return;
      press.dragging = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      event.currentTarget.dataset.dragging = "";
    }
    const slot = tabSlot(event.clientX);
    if (!slot) return;
    slot.capsule.style.setProperty("--tab-drag-x", `${slot.offset}px`);
    if (slot.index !== press.index) {
      press.index = slot.index;
      void hapticSelection();
    }
  }

  function endTabPress(event: React.PointerEvent<HTMLDivElement>, commit: boolean) {
    const press = tabPress.current;
    if (!press || press.pointerId !== event.pointerId) return;
    tabPress.current = null;
    const capsule = event.currentTarget;
    // Select the released tab now. iOS fires the tap's click a frame or more
    // after pointerup; until then the lens sprang back to the old tab and then
    // out again to the new one, which read as a tremble.
    const released = tabRoots()[press.index];
    if (commit && released && released.id !== landedTabId && !anyFormDirty()) {
      setPendingTab({ id: released.id, from: pathname });
    }
    requestAnimationFrame(() => {
      delete capsule.dataset.pressing;
      delete capsule.dataset.dragging;
    });
    if (!press.dragging || !commit) return;
    // After a slide the click lands on the capsule, not a link: open the tab here.
    swallowTabClick.current = true;
    window.setTimeout(() => {
      swallowTabClick.current = false;
    }, 0);
    const tab = tabRoots()[press.index];
    if (tab) goToRoot({ preventDefault: () => {} }, tab);
  }

  function renderTab(item: NavEntry) {
    const active = activeTabId === item.id;
    return (
      <Link
        key={item.id}
        href={item.path}
        prefetch
        onClick={(event) => goToRoot(event, item)}
        onPointerEnter={() => router.prefetch(tabTarget(item.id) ?? item.path)}
        onFocus={() => router.prefetch(tabTarget(item.id) ?? item.path)}
        className={`tab-item relative z-[1] flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 transition-colors active-press ${
          active ? "text-accent" : "text-ink"
        }`}
        aria-current={active ? "page" : undefined}
      >
        <Icon icon={rootIcon(item.id)} size="hero" strokeWidth={active ? 2.25 : 1.75} />
        {/* Icon-only bar: the name stays for VoiceOver and the link's text. */}
        <span className="sr-only">{item.label}</span>
      </Link>
    );
  }

  const backName = backLabel ?? back?.label ?? null;

  const inlineRootHeader = INLINE_HEADER_ROOTS.includes(pathname);
  const headerActions = (
          sessionStatus !== "signed-out" ? (
            <div className="flex items-center gap-1 justify-self-end">
              <button
                type="button"
                onClick={() => setChatOpenOn(pathname)}
                aria-label="Avustaja"
                className="header-circle active-press flex h-11 w-11 items-center justify-center"
              >
                <span className="shell-chat-icon flex h-10 w-10 items-center justify-center rounded-full bg-white text-ink">
                  <Icon icon={MessageCircle} />
                </span>
              </button>
              <button
                type="button"
                onClick={() => setProfileOpenOn((open) => (open === pathname ? null : pathname))}
                aria-label="Profiili, asetukset ja uloskirjautuminen"
                aria-haspopup="dialog"
                className="header-circle active-press flex h-11 w-11 items-center justify-center"
              >
                {/* A stable tile: the initial fills it in, a person glyph never swaps for it (VS-33). */}
                <span className="shell-profile-icon flex h-10 w-10 items-center justify-center rounded-full text-body font-medium text-white">
                  {initials}
                </span>
              </button>
            </div>
          ) : (
            <div className="w-11" aria-hidden />
          )
  );

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
        onPointerEnter={() => router.prefetch(tabTarget(item.id) ?? item.path)}
        onFocus={() => router.prefetch(tabTarget(item.id) ?? item.path)}
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
    <div className="app-frame" data-design="stitch" data-inline-header={inlineRootHeader || undefined} data-tabs={isDetail ? "hidden" : undefined}>
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

          {!inlineRootHeader ? headerActions : null}
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
        <div key={pathname} ref={setPageNode} className={`app-page stitch-page${pathname.startsWith("/asetukset") ? " settings-page" : ""}`}>
          {/* Page fetches start in parallel with the session check -- there
              is no "checking session" gate. Only an actual sign-out (a
              confirmed 401, or mobile finding no stored token) blanks this;
              SessionProvider is already navigating away by then. */}
          {onboardingSnoozed && !showOnboarding && pathname === "/dashboard" && (
            <OnboardingResumeCard onResume={() => setShowOnboarding(true)} />
          )}
          <PageHeaderActionsContext.Provider value={inlineRootHeader ? headerActions : null}>
            {sessionStatus === "signed-out" ? null : children}
          </PageHeaderActionsContext.Provider>
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
              // F21: Koti stays mounted behind the dialog with the profile from before the answers.
              void refreshSharedProfile();
            }}
            onSnooze={() => {
              setOnboardingSnoozed(true);
              setShowOnboarding(false);
            }}
          />

          {/* Stays mounted on detail routes and slides away (SHELL-13). */}
          {/* A floating glass capsule (iOS 26): the four tabs share one track with a
              sliding selection lens; the primary "+" floats beside it on its own. */}
          <nav
            className="app-tab-bar z-50"
            aria-label="Päävalikko"
            aria-hidden={isDetail || undefined}
            inert={isDetail}
            onContextMenu={(event) => event.preventDefault()}
          >
            <div className="mx-auto flex max-w-lg items-center gap-3">
              <div
                ref={capsuleRef}
                className="tab-capsule"
                style={{ "--tab-count": tabRoots().length, "--tab-index": Math.max(activeTabIndex, 0) } as React.CSSProperties}
                onPointerDown={onTabPointerDown}
                onPointerMove={onTabPointerMove}
                onPointerUp={(event) => endTabPress(event, true)}
                onPointerCancel={(event) => endTabPress(event, false)}
                onClickCapture={(event) => {
                  if (!swallowTabClick.current) return;
                  event.preventDefault();
                  event.stopPropagation();
                }}
              >
                                <span aria-hidden className="tab-lens" data-visible={activeTabIndex >= 0 || undefined}>
                  <span className="tab-lens-body" />
                </span>
                {tabRoots().map((item) => renderTab(item))}
              </div>
              {/* The primary control (OWN-03), the same height as the capsule. */}
              <button
                type="button"
                onClick={() => {
                  void hapticImpact("light");
                  setAddOpenOn(pathname);
                }}
                aria-label="Lisää"
                aria-haspopup="dialog"
                aria-expanded={addOpen}
                className="tab-plus flex flex-none items-center justify-center rounded-full bg-ink text-canvas"
              >
                <Icon icon={Plus} size="hero" strokeWidth={2} />
              </button>
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
                  <span className="block text-base font-semibold">Kuvaa kuitti</span>
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
                    <span className="mt-0.5 block clamp-lines text-caption text-ink-2">CSV, XLSX, camt tai PDF</span>
                  </span>
                </button>
                {(
                  [
                    { href: "/laskut/uusi", label: "Uusi lasku", icon: FilePlus },
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
                    {signingOut ? "Kirjataan ulos…" : "Kirjaa ulos"}
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
