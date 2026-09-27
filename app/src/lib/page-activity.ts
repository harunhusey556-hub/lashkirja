/** Polling and motion pause while the document is in the background. */

export function pollDelay(visibility: string, intervalMs: number): number | null {
  if (visibility === "hidden") return null;
  return intervalMs;
}

export function syncPageHiddenFlag(hidden: boolean): void {
  if (typeof document === "undefined") return;
  if (hidden) document.documentElement.setAttribute("data-page-hidden", "");
  else document.documentElement.removeAttribute("data-page-hidden");
}
