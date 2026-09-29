/**
 * The return key contract (C6, IA-11). One document-level handler, so every
 * form in the app behaves the same without per-form wiring:
 *
 * - `enterkeyhint="next"` ("Seuraava"): Enter moves focus to the next field
 *   of the same form (or sheet, or page) and never submits. On the last
 *   field it blurs, which closes the keyboard.
 * - `enterkeyhint="done"` ("Valmis"): Enter blurs and never submits.
 * - `go`, `send`, `search` or no hint: the browser default (implicit submit).
 *
 * A form (or any ancestor) with `data-enter="native"` opts out entirely.
 * Textareas are never touched (Enter is a newline there).
 */

const FIELD_SELECTOR = [
  "input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=file]):not([type=button]):not([type=submit]):not([type=reset]):not([type=range])",
  "select",
  "textarea",
].join(",");

function scopeOf(field: HTMLElement): HTMLElement {
  return (
    field.closest<HTMLElement>("form") ??
    field.closest<HTMLElement>('[role="dialog"], [role="alertdialog"]') ??
    field.closest<HTMLElement>(".app-main, .bare-frame") ??
    document.body
  );
}

function usable(el: HTMLElement): boolean {
  if (el.matches(":disabled")) return false;
  if ((el as HTMLInputElement).readOnly) return false;
  if (el.closest("[inert], [aria-hidden='true']")) return false;
  return el.getClientRects().length > 0;
}

/** The next usable field after `from` in its scope, in DOM order. */
export function nextField(from: HTMLElement): HTMLElement | null {
  const fields = Array.from(scopeOf(from).querySelectorAll<HTMLElement>(FIELD_SELECTOR));
  const index = fields.indexOf(from);
  if (index < 0) return null;
  for (const candidate of fields.slice(index + 1)) {
    if (usable(candidate)) return candidate;
  }
  return null;
}

/**
 * Moves focus to the next field, or blurs `from` when it is the last one.
 * Returns true when focus moved. Exported for controls that manage their
 * own keys (a custom picker can call it on its own "next").
 */
export function focusNextField(from: HTMLElement): boolean {
  const next = nextField(from);
  if (next) {
    next.focus();
    return true;
  }
  from.blur();
  return false;
}

/** The keydown handler; returns true when it handled (and prevented) Enter. */
export function handleEnterKey(event: KeyboardEvent): boolean {
  if (event.key !== "Enter" || event.isComposing || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) {
    return false;
  }
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return false;
  if (target.closest('[data-enter="native"]')) return false;
  const hint = (target.getAttribute("enterkeyhint") ?? "").toLowerCase();
  if (hint !== "next" && hint !== "done") return false;
  event.preventDefault();
  if (hint === "next") focusNextField(target);
  else target.blur();
  return true;
}

let installed = false;

/** Installs the handler once for the whole document (layout does this). */
export function installEnterNext(): () => void {
  if (installed || typeof document === "undefined") return () => {};
  installed = true;
  const onKeyDown = (event: KeyboardEvent) => {
    handleEnterKey(event);
  };
  document.addEventListener("keydown", onKeyDown, true);
  return () => {
    installed = false;
    document.removeEventListener("keydown", onKeyDown, true);
  };
}
