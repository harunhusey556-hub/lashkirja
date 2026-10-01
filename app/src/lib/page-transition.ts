/**
 * iOS-style push/pop for the app shell (SHELL-28) and per-route scroll
 * memory (SHELL-07). DOM helpers only; AppShell decides when to call them.
 *
 * The page lives in a keyed `.app-page` wrapper inside one persistent
 * <main>. When the key changes React detaches the old wrapper but leaves its
 * subtree intact, so the old node itself is the snapshot: it is re-parented
 * into an overlay positioned exactly over <main>, at the scroll offset it
 * was left at, and slid out while <main> slides the new page in.
 */

/** Scroll offset per pathname, updated on every scroll of <main>. */
const scrollMemory = new Map<string, number>();

export function rememberScroll(pathname: string, top: number): void {
  scrollMemory.set(pathname, Math.max(0, Math.round(top)));
  if (scrollMemory.size > 40) {
    const oldest = scrollMemory.keys().next().value;
    if (oldest !== undefined) scrollMemory.delete(oldest);
  }
}

export function recalledScroll(pathname: string): number {
  return scrollMemory.get(pathname) ?? 0;
}

export function forgetScroll(pathname: string): void {
  scrollMemory.delete(pathname);
}

/** The last detached page node per pathname (the parent under an edge swipe). */
const pageNodes = new Map<string, HTMLElement>();

export function keepPageNode(pathname: string, node: HTMLElement): void {
  pageNodes.delete(pathname);
  pageNodes.set(pathname, node);
  while (pageNodes.size > 4) {
    const oldest = pageNodes.keys().next().value;
    if (oldest === undefined) break;
    pageNodes.delete(oldest);
  }
}

export function pageNodeFor(pathname: string | null): HTMLElement | null {
  if (!pathname) return null;
  return pageNodes.get(pathname) ?? null;
}

/** Drops remembered scroll offsets and kept page nodes (end of a session). */
export function resetPageTransition(): void {
  scrollMemory.clear();
  pageNodes.clear();
}

export const resetPageTransitionForTests = resetPageTransition;

export type SnapshotMode = "push-out" | "pop-out" | "tab-out" | "swipe-under";

/**
 * Places `page` (a detached `.app-page` node) in an overlay over `main`,
 * scrolled to `scrollTop`, with `paddingTop` as <main> had it for that page.
 */
export function mountSnapshot(
  main: HTMLElement,
  page: HTMLElement,
  scrollTop: number,
  mode: SnapshotMode,
  paddingTop?: string
): HTMLElement | null {
  const frame = main.parentElement;
  if (!frame) return null;
  const style = getComputedStyle(main);
  const snap = document.createElement("div");
  snap.className = `page-snapshot page-${mode}`;
  snap.setAttribute("aria-hidden", "true");
  snap.inert = true;
  snap.style.top = `${main.offsetTop}px`;
  snap.style.left = `${main.offsetLeft}px`;
  snap.style.width = `${main.offsetWidth}px`;
  snap.style.height = `${main.offsetHeight}px`;
  snap.style.right = "auto";
  snap.style.bottom = "auto";

  const inner = document.createElement("div");
  inner.style.paddingTop = paddingTop ?? style.paddingTop;
  inner.style.paddingRight = style.paddingRight;
  inner.style.paddingLeft = style.paddingLeft;
  inner.style.transform = `translateY(${-scrollTop}px)`;
  page.classList.remove("page-push-in", "page-pop-in");
  inner.appendChild(page);
  snap.appendChild(inner);
  frame.appendChild(snap);
  return snap;
}

/** Removes a snapshot on its animation end, with a timer as a fallback. */
export function removeSnapshotAfter(snap: HTMLElement, ms: number): () => void {
  let done = false;
  const remove = () => {
    if (done) return;
    done = true;
    window.clearTimeout(timer);
    snap.removeEventListener("animationend", onEnd);
    snap.remove();
  };
  const onEnd = (event: AnimationEvent) => {
    if (event.target === snap) remove();
  };
  snap.addEventListener("animationend", onEnd);
  const timer = window.setTimeout(remove, ms);
  return remove;
}

/**
 * Batch 3 (OWN-17/19): the push/pop/tab transition, driven by the Web
 * Animations API instead of CSS classes added in the commit.
 *
 * Root cause of the "flash" (evidence: .superpowers/quality/batch-3/laneB):
 * the CSS keyframes started in the same frame as the new page's first,
 * heaviest render, so the first frame the user saw was already 30 % into a
 * front-loaded curve (push: the page jumped ~50 % of the screen between two
 * frames), and a tab switch painted the whole new page at 55 % opacity for a
 * frame (a dim blink). Here the old page stays fully in place for the commit
 * frame, and the motion starts on the next frame, after that paint, from
 * zero velocity on a critically damped spring (--ease-nav, --dur-push).
 */
export type NavTransitionKind = "push" | "pop" | "tab";

/** Parallax of the page underneath a push/pop (iOS shifts it ~30 %). */
export const UNDER_SHIFT = "-30%";
/** Tab crossfade and the reduced-motion replacement for every transition. */
export const FADE_MS = 180;
/** Longest the push waits for the incoming page to replace its skeleton. */
const CONTENT_WAIT_MS = 80;

function cssVar(name: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function msVar(name: string, fallback: number): number {
  const raw = cssVar(name, "");
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return raw.endsWith("ms") ? parsed : raw.endsWith("s") ? parsed * 1000 : parsed;
}

export function navDurationMs(): number {
  return msVar("--dur-push", 420);
}

export function navEasing(): string {
  return cssVar("--ease-nav", "cubic-bezier(0.3, 0.6, 0.15, 1)");
}

function hasSkeleton(page: Element | null): boolean {
  return Boolean(page?.querySelector('.skeleton, .animate-pulse, [aria-busy="true"]'));
}

/** A dimming layer exactly over `main` (the page underneath a pop). */
function mountScrim(main: HTMLElement): HTMLElement | null {
  const frame = main.parentElement;
  if (!frame) return null;
  const scrim = document.createElement("div");
  scrim.className = "page-scrim";
  scrim.setAttribute("aria-hidden", "true");
  scrim.style.top = `${main.offsetTop}px`;
  scrim.style.left = `${main.offsetLeft}px`;
  scrim.style.width = `${main.offsetWidth}px`;
  scrim.style.height = `${main.offsetHeight}px`;
  frame.appendChild(scrim);
  return scrim;
}

/**
 * Plays one navigation transition. Call it in the layout effect of the
 * landing (before the commit is painted) with the detached old page; it
 * returns a cancel that jumps to the end state and removes the overlay.
 */
export function playNavTransition(options: {
  main: HTMLElement;
  oldPage: HTMLElement | null;
  oldScroll: number;
  oldPaddingTop?: string;
  kind: NavTransitionKind;
  newPage?: Element | null;
}): () => void {
  const { main, oldPage, oldScroll, oldPaddingTop, newPage } = options;
  const reduced = prefersReducedMotion();
  const kind: NavTransitionKind = reduced ? "tab" : options.kind;
  const canAnimate = typeof main.animate === "function";
  if (!oldPage || !canAnimate) return () => {};

  const mode: SnapshotMode = kind === "push" ? "push-out" : kind === "pop" ? "pop-out" : "tab-out";
  const snap = mountSnapshot(main, oldPage, oldScroll, mode, oldPaddingTop);
  if (!snap) return () => {};

  let scrim: HTMLElement | null = null;
  let snapScrim: HTMLElement | null = null;
  // The commit frame: the old page covers the new one exactly where it was.
  if (kind === "push") {
    main.style.transform = "translateX(100%)";
    main.style.zIndex = "1";
    main.dataset.navMoving = "push";
    snapScrim = document.createElement("div");
    snapScrim.className = "page-snapshot-scrim";
    snap.appendChild(snapScrim);
  } else if (kind === "pop") {
    main.style.transform = `translateX(${UNDER_SHIFT})`;
    scrim = mountScrim(main);
    if (scrim) scrim.style.opacity = "1";
  }

  const animations: Animation[] = [];
  let raf = 0;
  let safety = 0;
  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    cancelAnimationFrame(raf);
    window.clearTimeout(safety);
    for (const animation of animations) animation.cancel();
    main.style.transform = "";
    main.style.zIndex = "";
    delete main.dataset.navMoving;
    snap.remove();
    scrim?.remove();
  };

  const start = () => {
    if (done) return;
    const duration = kind === "tab" ? (reduced ? FADE_MS - 40 : FADE_MS) : navDurationMs();
    const easing = kind === "tab" ? "cubic-bezier(0.23, 1, 0.32, 1)" : navEasing();
    const timing: KeyframeAnimationOptions = { duration, easing, fill: "both" };
    if (kind === "push") {
      animations.push(main.animate([{ transform: "translateX(100%)" }, { transform: "translateX(0)" }], timing));
      animations.push(snap.animate([{ transform: "translateX(0)" }, { transform: `translateX(${UNDER_SHIFT})` }], timing));
      if (snapScrim) animations.push(snapScrim.animate([{ opacity: 0 }, { opacity: 1 }], timing));
    } else if (kind === "pop") {
      animations.push(main.animate([{ transform: `translateX(${UNDER_SHIFT})` }, { transform: "translateX(0)" }], timing));
      animations.push(snap.animate([{ transform: "translateX(0)" }, { transform: "translateX(100%)" }], timing));
      if (scrim) animations.push(scrim.animate([{ opacity: 1 }, { opacity: 0 }], timing));
    } else {
      animations.push(snap.animate([{ opacity: 1 }, { opacity: 0 }], timing));
    }
    // The animations own the start values now; nothing inline may outlive them.
    main.style.transform = "";
    if (scrim) scrim.style.opacity = "";
    const lead = animations[0];
    lead.finished.then(cleanup, () => {});
    // Safety net: never leave an overlay if `finished` never settles.
    safety = window.setTimeout(cleanup, duration + 250);
  };

  // Start on the frame after the commit frame was painted. A push waits a
  // few frames (CONTENT_WAIT_MS at most) for a cached page to replace its
  // skeleton, so the page slides in whole instead of popping in after.
  const committedAt = performance.now();
  const next = () => {
    raf = 0;
    if (kind === "push" && hasSkeleton(newPage ?? null) && performance.now() - committedAt < CONTENT_WAIT_MS) {
      raf = requestAnimationFrame(next);
      return;
    }
    start();
  };
  raf = requestAnimationFrame(next);
  return cleanup;
}

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
}
