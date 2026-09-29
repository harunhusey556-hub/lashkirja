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

export function resetPageTransitionForTests(): void {
  scrollMemory.clear();
  pageNodes.clear();
}

export type SnapshotMode = "push-out" | "pop-out" | "swipe-under";

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

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
}
