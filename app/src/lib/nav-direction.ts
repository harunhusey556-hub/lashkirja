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

export function resetNavigationForTests(): void {
  lastPathname = null;
  poppedNavigation = false;
  intents = [];
  shownFor = null;
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
