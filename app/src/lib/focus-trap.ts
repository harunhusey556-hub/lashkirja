/**
 * Tab cycle and stacked-dialog order shared by every modal.
 * The top registration is the only one that should handle Escape.
 */
const stack: number[] = [];
let sequence = 0;
let lastTrigger: HTMLElement | null = null;

if (typeof document !== "undefined") {
  document.addEventListener(
    "pointerdown",
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const control = target.closest("button, a, [role='button']");
      // A control inside an open dialog is never the trigger to return to:
      // tapping "Poista" in a menu sheet must not replace the "..." button
      // that opened the menu (WebKit and iOS do not focus a tapped button,
      // so this fallback is what restores focus there).
      if (control instanceof HTMLElement && !control.closest('[aria-modal="true"]')) lastTrigger = control;
    },
    true
  );
}

/** Prefer the element that had focus. A pointer tap often leaves focus on body, so the pressed control is the fallback. */
export function pickRestoreElement(
  previous: HTMLElement | null,
  container: HTMLElement | null
): HTMLElement | null {
  const usable = (node: HTMLElement | null) =>
    Boolean(
      node &&
        node.isConnected &&
        node !== document.body &&
        node !== document.documentElement &&
        !(container && container.contains(node))
    );
  if (usable(previous)) return previous;
  if (usable(lastTrigger)) return lastTrigger;
  return null;
}

export function pushTrap(): { id: number; release: () => void } {
  const id = ++sequence;
  stack.push(id);
  return {
    id,
    release() {
      const index = stack.lastIndexOf(id);
      if (index >= 0) stack.splice(index, 1);
    },
  };
}

export function topTrapId(): number | null {
  return stack.length > 0 ? stack[stack.length - 1] : null;
}

export function resetTrapsForTests(): void {
  stack.length = 0;
  sequence = 0;
}

/**
 * Next element inside a trap. A focus target outside the list is pulled to
 * the first control. Shift+Tab on the first control wraps to the last.
 */
export function nextFocusable<T>(items: readonly T[], current: T | null, shiftKey: boolean): T | null {
  if (items.length === 0) return null;
  const index = current == null ? -1 : items.indexOf(current);
  if (index < 0) return items[0];
  if (shiftKey && index === 0) return items[items.length - 1];
  if (!shiftKey && index === items.length - 1) return items[0];
  return items[index + (shiftKey ? -1 : 1)];
}
