/** Lists at or below this many rows render fully: windowing only pays off on a long ledger. */
export const WINDOW_THRESHOLD = 200;
const DEFAULT_OVERSCAN = 8;

export interface RowWindow {
  start: number;
  end: number;
  padTop: number;
  padBottom: number;
}

/**
 * Which rows of a long list to mount. `listTop` is the list's top edge relative
 * to the scroll area's own top (negative once scrolled past it). Rows are
 * assumed to be about `rowHeight` tall; the spacers keep the scroll height
 * right so the scrollbar and "scroll back to where I was" still work.
 */
export function computeWindow(input: {
  count: number;
  rowHeight: number;
  listTop: number;
  viewportHeight: number;
  overscan?: number;
  threshold?: number;
}): RowWindow {
  const { count, rowHeight, listTop, viewportHeight } = input;
  const overscan = input.overscan ?? DEFAULT_OVERSCAN;
  if (count <= (input.threshold ?? WINDOW_THRESHOLD) || rowHeight <= 0) {
    return { start: 0, end: count, padTop: 0, padBottom: 0 };
  }
  const firstVisible = Math.floor(-listTop / rowHeight);
  const lastVisible = Math.ceil((-listTop + viewportHeight) / rowHeight);
  const start = Math.max(0, Math.min(count - 1, firstVisible - overscan));
  const end = Math.max(start + 1, Math.min(count, lastVisible + overscan));
  return { start, end, padTop: start * rowHeight, padBottom: (count - end) * rowHeight };
}
