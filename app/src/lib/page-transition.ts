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
  // Batch every geometry read before appending anything to the live DOM.
  const style = getComputedStyle(main);
  const geometry = { top: main.offsetTop, left: main.offsetLeft, width: main.offsetWidth, height: main.offsetHeight, paddingTop: paddingTop ?? style.paddingTop, paddingRight: style.paddingRight, paddingLeft: style.paddingLeft };
  const snap = document.createElement("div");
  snap.className = `page-snapshot page-${mode}`;
  snap.setAttribute("aria-hidden", "true");
  snap.inert = true;
  snap.style.top = `${geometry.top}px`;
  snap.style.left = `${geometry.left}px`;
  snap.style.width = `${geometry.width}px`;
  snap.style.height = `${geometry.height}px`;
  snap.style.right = "auto";
  snap.style.bottom = "auto";

  const inner = document.createElement("div");
  inner.style.paddingTop = geometry.paddingTop;
  inner.style.paddingRight = geometry.paddingRight;
  inner.style.paddingLeft = geometry.paddingLeft;
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

/** Full spatial navigation, with compositor layers prepared before motion. */
export type NavTransitionKind = "push" | "pop" | "tab" | "present";

/** Parallax of the page underneath a push/pop (iOS shifts it ~30 %). */
export const UNDER_SHIFT = "-30%";
/** Tab fade-in and the reduced-motion replacement for every transition. */
export const FADE_MS = 200;

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
  const { main, oldPage, oldScroll, oldPaddingTop, kind } = options;
  if (typeof main.animate !== "function") return () => {};
  if (kind === "tab" || prefersReducedMotion() || !oldPage) return playFadeIn(main);
  // Read tokens before inserting the snapshot; no layout reads during motion.
  const duration = navDurationMs();
  const easing = navEasing();
  // Present (the avatar's Asetukset): the new page rises like an iOS sheet
  // over the old one, which stays put and dims.
  const covers = kind === "push" || kind === "present";
  const mainFrom =
    kind === "push" ? "translate3d(100%, 0, 0)" : kind === "present" ? "translate3d(0, 100%, 0)" : `translate3d(${UNDER_SHIFT}, 0, 0)`;
  const snapTo =
    kind === "push" ? `translate3d(${UNDER_SHIFT}, 0, 0)` : kind === "present" ? "translate3d(0, 0, 0)" : "translate3d(100%, 0, 0)";
  const snap = mountSnapshot(main, oldPage, oldScroll, covers ? "push-out" : "pop-out", oldPaddingTop);
  if (!snap) return () => {};
  const scrim = document.createElement("div");
  scrim.setAttribute("aria-hidden", "true");
  scrim.className = covers ? "page-snapshot-scrim" : "page-scrim";
  if (covers) snap.appendChild(scrim);
  else {
    scrim.style.top = snap.style.top;
    scrim.style.left = snap.style.left;
    scrim.style.width = snap.style.width;
    scrim.style.height = snap.style.height;
    scrim.style.opacity = "1";
    main.parentElement?.appendChild(scrim);
  }
  const previousWillChange = main.style.willChange;
  main.style.willChange = "transform";
  snap.style.willChange = "transform";
  main.dataset.navMoving = kind;
  main.style.transform = mainFrom;
  main.style.zIndex = covers ? "1" : "";
  const animations: Animation[] = [];
  let raf = 0;
  let timer = 0;
  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    cancelAnimationFrame(raf);
    window.clearTimeout(timer);
    for (const animation of animations) animation.cancel();
    main.style.transform = "";
    main.style.zIndex = "";
    main.style.willChange = previousWillChange;
    delete main.dataset.navMoving;
    snap.remove();
    scrim.remove();
    main.dispatchEvent(new Event("lashkirja-nav-settled"));
  };
    const timing: KeyframeAnimationOptions = { duration, easing, fill: "both" };
    animations.push(main.animate([{ transform: mainFrom }, { transform: "translate3d(0, 0, 0)" }], timing));
    animations.push(snap.animate([{ transform: "translate3d(0, 0, 0)" }, { transform: snapTo }], timing));
    animations.push(scrim.animate(covers ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 1 }, { opacity: 0 }], timing));

  // Construct and rasterize paused animations before starting their clocks.
  // Creating a moving animation during its first frame made a busy form
  // jump ahead while the browser was still preparing its layers.
  for (const animation of animations) { animation.pause(); animation.currentTime = 0; }
  const start = () => {
    if (done) return;
    const startedAt = document.timeline.currentTime;
    for (const animation of animations) {
      animation.play();
      if (typeof startedAt === "number") animation.startTime = startedAt;
    }
    main.style.transform = "";
    animations[0].finished.then(cleanup, cleanup);
  };
  // One paint prepares/rasterizes both isolated layers before the spring
  // starts. Route mounting and the first moving frame no longer compete.
  raf = requestAnimationFrame(() => { raf = requestAnimationFrame(start); });
  timer = window.setTimeout(cleanup, duration + 500);
  return cleanup;
}

/**
 * Tab switch: the old page is gone at once and the new one fades in. Only
 * the incoming page moves, so two pages' text never blend (iOS swaps tabs
 * outright; this only takes the edge off the cut).
 */
function playFadeIn(main: HTMLElement): () => void {
  main.dataset.navMoving = "fade";
  // Its own layer for the fade, so the glass tab bar above samples a
  // composited surface instead of repainting the page every frame.
  main.style.willChange = "opacity";
  const animation = main.animate([{ opacity: 0 }, { opacity: 1 }], {
    duration: FADE_MS,
    easing: "cubic-bezier(0.2, 0, 0, 1)",
    fill: "backwards",
  });
  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    animation.cancel();
    main.style.willChange = "";
    delete main.dataset.navMoving;
    main.dispatchEvent(new Event("lashkirja-nav-settled"));
  };
  animation.finished.then(cleanup, cleanup);
  return cleanup;
}

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
}

/** Await layer teardown, including the preparation frames before WAAPI starts. */
export function whenNavigationSettles(): Promise<void> {
  const main = document.querySelector<HTMLElement>(".app-main[data-nav-moving]");
  if (!main) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => {
      window.clearTimeout(timer);
      main.removeEventListener("lashkirja-nav-settled", finish);
      resolve();
    };
    const timer = window.setTimeout(finish, 1000);
    main.addEventListener("lashkirja-nav-settled", finish);
  });
}
