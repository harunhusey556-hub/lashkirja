/**
 * One navigation intent for the whole app.
 *
 * Forward, back, and tab transitions all go through this queue so a second
 * tap cannot steal the animation that belonged to the first destination.
 * Sheets and dialogs stay on BottomSheet / ConfirmModal; they are not routes.
 */
export type NavDirection = "forward" | "back" | "tab" | "none";

type ArmedDirection = Exclude<NavDirection, "none">;

type Intent = { pathname: string; direction: ArmedDirection };

let lastPathname: string | null = null;
let poppedNavigation = false;
let intents: Intent[] = [];
/** Same landing rendered twice (Strict Mode) must not consume the queue twice. */
let shownFor: { pathname: string; direction: NavDirection } | null = null;

let memoryStack: string[] = [];

function readStack(): string[] {
  return memoryStack;
}

function writeStack(stack: string[]): void {
  memoryStack = stack.slice(-30);
}

export function resetNavigationForTests(): void {
  lastPathname = null;
  poppedNavigation = false;
  intents = [];
  shownFor = null;
  memoryStack = [];
}

/** Where the shell back button goes when this document has no in-app history. */
export function fallbackBackPath(pathname: string): string {
  const segments = pathname.split("/").filter(Boolean);
  segments.pop();
  return segments.length > 0 ? `/${segments.join("/")}` : "/dashboard";
}

/**
 * Remember landings so back can tell an in-app previous screen from a deep
 * link. A deep link or refresh has no predecessor and uses fallbackBackPath.
 */
export function recordRoute(pathname: string, direction: NavDirection): void {
  const stack = readStack();
  if (stack[stack.length - 1] === pathname) return;
  if (direction === "back") {
    const at = stack.lastIndexOf(pathname);
    writeStack(at >= 0 ? stack.slice(0, at + 1) : [pathname]);
    return;
  }
  writeStack([...stack, pathname]);
}

/** Previous in-app screen, or null when this entry was opened directly. */
export function inAppPrevious(pathname: string): string | null {
  const stack = readStack();
  if (stack.length >= 2 && stack[stack.length - 1] === pathname) {
    return stack[stack.length - 2];
  }
  return null;
}

export function performInAppBack(
  pathname: string,
  router: { back: () => void; replace: (href: string) => void },
  fallback: string = fallbackBackPath(pathname)
): void {
  if (inAppPrevious(pathname)) {
    markHistoryBack();
    router.back();
    return;
  }
  armNavigation(fallback, "back");
  router.replace(fallback);
}

/** Remember which way the next landing on `pathname` should animate. */
export function armNavigation(pathname: string, direction: ArmedDirection): void {
  poppedNavigation = false;
  intents = intents.filter((item) => item.pathname !== pathname);
  intents.push({ pathname, direction });
  if (intents.length > 8) intents.shift();
}

/** Browser or edge-swipe back. The destination is not known until it lands. */
export function markHistoryBack(): void {
  poppedNavigation = true;
}

function routeDepth(pathname: string): number {
  return pathname.split("/").filter(Boolean).length;
}

export function consumeDirection(pathname: string): NavDirection {
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

  let direction: NavDirection = "tab";
  if (previous === null || previous === pathname) direction = "none";
  else if (armed) direction = armed.direction;
  else if (popped) direction = "back";
  else {
    const from = routeDepth(previous);
    const to = routeDepth(pathname);
    if (to > from) direction = "forward";
    else if (to < from) direction = "back";
  }
  shownFor = { pathname, direction };
  return direction;
}
