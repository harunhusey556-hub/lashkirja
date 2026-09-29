/**
 * One navigation intent for the whole app (C2, C1.5).
 *
 * The transition direction comes from the GESTURE SOURCE, never from URL
 * depth (IA-05..07):
 * - the tab bar, the sidebar and the avatar sheet arm "tab" (no animation);
 * - the back button and the edge swipe arm "back" or mark a history pop;
 * - popstate (OS or browser back) marks a history pop;
 * - everything else is an in-content action (a link, a row, a menu item, a
 *   save): AppShell arms every in-content link click as "forward", and an
 *   unarmed code navigation is a push, except a return to a registry
 *   ancestor (e.g. "delete, back to the list"), which pops.
 *
 * Each tab keeps its own stack (IA-25): a push stays in the tab it started
 * from, so a cross-tab jump (Koti -> Kuitit) keeps Koti highlighted and its
 * back goes to Koti (IA-07). Tapping another tab returns to that tab's last
 * screen. Sheets and dialogs stay on BottomSheet / ConfirmModal; they are
 * not routes.
 */
import { rootIdOf } from "./navigation";

export type NavDirection = "forward" | "back" | "tab" | "none";

type ArmedDirection = Exclude<NavDirection, "none">;

type Intent = { pathname: string; direction: ArmedDirection; tab?: string };

type StackEntry = { path: string; href: string };

type TabStack = {
  entries: StackEntry[];
  /**
   * Index of the first entry that is backed by the browser history in
   * order. Entries below it were restored from memory (a tab switch back to
   * a remembered screen), so going back to them is a replace, not
   * history.back().
   */
  base: number;
};

let lastPathname: string | null = null;
let poppedNavigation = false;
let intents: Intent[] = [];
/** Same landing rendered twice (Strict Mode) must not consume the queue twice. */
let shownFor: { pathname: string; direction: NavDirection; tab?: string } | null = null;

let stacks = new Map<string, TabStack>();
let activeTab: string | null = null;

const NO_TAB = "_";

function tabFor(pathname: string): string {
  return rootIdOf(pathname) ?? NO_TAB;
}

export function resetNavigationForTests(): void {
  lastPathname = null;
  poppedNavigation = false;
  intents = [];
  shownFor = null;
  stacks = new Map();
  activeTab = null;
}

/** Where the shell back button goes when this document has no in-app history. */
export function fallbackBackPath(pathname: string): string {
  const segments = pathname.split("/").filter(Boolean);
  segments.pop();
  return segments.length > 0 ? `/${segments.join("/")}` : "/dashboard";
}

function stackOf(tab: string | null): TabStack | null {
  return tab ? stacks.get(tab) ?? null : null;
}

/** The tab that is active once `pathname` has landed with `direction`. Pure. */
export function tabAfterLanding(pathname: string, direction: NavDirection): string {
  if (direction === "tab") {
    return shownFor?.pathname === pathname && shownFor.tab ? shownFor.tab : tabFor(pathname);
  }
  const current = stackOf(activeTab);
  if (direction === "forward" && activeTab && current) return activeTab;
  if (direction === "back" && activeTab && current?.entries.some((entry) => entry.path === pathname)) {
    return activeTab;
  }
  if (activeTab && current?.entries.at(-1)?.path === pathname) return activeTab;
  return tabFor(pathname);
}

/** The stack of `tab` after landing, computed without recording. */
function stackAfterLanding(pathname: string, direction: NavDirection, tab: string): TabStack {
  const existing = stacks.get(tab);
  const entries = existing ? [...existing.entries] : [];
  let base = existing?.base ?? 0;
  const top = entries.at(-1);
  if (top?.path === pathname) return { entries, base };
  if (direction === "tab" || direction === "none") {
    // A tab landing that is not the remembered top starts the tab afresh.
    return { entries: [{ path: pathname, href: pathname }], base: 0 };
  }
  if (direction === "back") {
    const at = entries.map((entry) => entry.path).lastIndexOf(pathname);
    if (at < 0) return { entries: [{ path: pathname, href: pathname }], base: 0 };
    const kept = entries.slice(0, at + 1);
    return { entries: kept, base: Math.min(base, kept.length - 1) };
  }
  entries.push({ path: pathname, href: pathname });
  if (entries.length > 30) {
    entries.shift();
    base = Math.max(0, base - 1);
  }
  return { entries, base };
}

/**
 * Remember a landing: which tab it belongs to and where back goes from it.
 * A deep link or refresh has no predecessor and uses fallbackBackPath.
 */
export function recordRoute(pathname: string, direction: NavDirection): void {
  const tab = tabAfterLanding(pathname, direction);
  const existing = stacks.get(tab);
  const next = stackAfterLanding(pathname, direction, tab);
  if (direction === "tab" && existing?.entries.at(-1)?.path === pathname) {
    // Restored from memory: only the top is in the live browser history.
    next.base = next.entries.length - 1;
  }
  stacks.set(tab, next);
  activeTab = tab;
}

/** Keeps the current entry's full href (query included) for a later restore or back. */
export function updateCurrentHref(pathname: string, href: string): void {
  const top = stackOf(activeTab)?.entries.at(-1);
  if (top && top.path === pathname) top.href = href;
}

/** The current screen becomes the root of `tab` (a tab tap on the screen already shown). */
export function adoptTab(tab: string, pathname: string): void {
  const href = stackOf(activeTab)?.entries.at(-1)?.href ?? pathname;
  stacks.set(tab, { entries: [{ path: pathname, href }], base: 0 });
  activeTab = tab;
  if (shownFor?.pathname === pathname) shownFor = { pathname, direction: "tab", tab };
}

/** The tab bar item that is highlighted (the tab the current stack belongs to). */
export function currentTab(): string | null {
  return activeTab;
}

/** Where tapping `tab` in the tab bar goes: its last screen, or null for its root. */
export function tabTarget(tab: string): string | null {
  const top = stacks.get(tab)?.entries.at(-1);
  return top ? top.href : null;
}

/** Previous in-app screen, or null when this entry was opened directly. */
export function inAppPrevious(pathname: string): string | null {
  const entries = stackOf(activeTab)?.entries ?? [];
  if (entries.length >= 2 && entries[entries.length - 1].path === pathname) {
    return entries[entries.length - 2].path;
  }
  return null;
}

/**
 * The screen the back button will return to once `pathname` has landed with
 * `direction`, computed without recording anything (safe during render).
 * Mirrors recordRoute; null when the entry was opened directly.
 */
export function previousAfterLanding(pathname: string, direction: NavDirection): string | null {
  const tab = tabAfterLanding(pathname, direction);
  const { entries } = stackAfterLanding(pathname, direction, tab);
  return entries.length >= 2 ? entries[entries.length - 2].path : null;
}

export function performInAppBack(
  pathname: string,
  router: { back: () => void; replace: (href: string) => void },
  fallback: string = fallbackBackPath(pathname)
): void {
  const stack = stackOf(activeTab);
  const entries = stack?.entries ?? [];
  if (stack && inAppPrevious(pathname)) {
    const previous = entries[entries.length - 2];
    if (entries.length - 2 >= stack.base) {
      markHistoryBack();
      router.back();
    } else {
      // Restored from memory: the browser history does not hold it.
      armNavigation(previous.path, "back");
      router.replace(previous.href);
    }
    return;
  }
  armNavigation(fallback.split("?")[0], "back");
  router.replace(fallback);
}

/**
 * Remember which way the next landing on `pathname` should animate. `tab`
 * names the tab a "tab" landing belongs to (the tapped tab, which may differ
 * from the target path's own root when a remembered screen is restored).
 */
export function armNavigation(pathname: string, direction: ArmedDirection, tab?: string): void {
  poppedNavigation = false;
  intents = intents.filter((item) => item.pathname !== pathname);
  intents.push({ pathname, direction, tab });
  if (intents.length > 8) intents.shift();
}

/** Browser or edge-swipe back. The destination is not known until it lands. */
export function markHistoryBack(): void {
  poppedNavigation = true;
}

/**
 * `relate` tells whether an UNARMED landing returns to a registry ancestor
 * (code navigation such as "deleted, back to the list"): that one pops.
 * Every other unarmed landing is an in-content push. URL depth is never used.
 */
export function consumeDirection(
  pathname: string,
  relate?: (from: string, to: string) => NavDirection | null
): NavDirection {
  if (shownFor?.pathname === pathname && lastPathname === pathname) {
    return shownFor.direction;
  }
  const previous = lastPathname;
  lastPathname = pathname;
  const index = intents.findIndex((item) => item.pathname === pathname);
  const armed = index >= 0 ? intents[index] : null;
  intents = index >= 0 ? intents.slice(index + 1) : [];
  const popped = poppedNavigation;
  poppedNavigation = false;

  let direction: NavDirection;
  if (previous === null || previous === pathname) direction = "none";
  else if (armed) direction = armed.direction;
  else if (popped) direction = "back";
  else direction = relate?.(previous, pathname) === "back" ? "back" : "forward";
  shownFor = { pathname, direction, tab: armed?.direction === "tab" ? armed.tab : undefined };
  return direction;
}

/** Normalises an in-app href to the pathname usePathname() reports. */
export function landingPath(href: string, base: string): string | null {
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return null;
  }
  if (url.origin !== new URL(base).origin) return null;
  let path = url.pathname.replace(/\.html$/, "");
  if (path.length > 1) path = path.replace(/\/+$/, "");
  return path || "/";
}
