/**
 * App-wide toasts (SHELL-23). One store, rendered by `ToastHost` inside the
 * app shell; any screen calls `showToast` directly.
 *
 *   showToast({ tone: "success", text: "Kuitti tallennettu" });
 *   showToast({
 *     tone: "info",
 *     text: "Lasku poistettu",
 *     action: { label: "Kumoa", onAction: () => restore(id) },
 *   });
 *
 * Rules (QUALITY-BAR F4, T4, L3):
 * - Finnish copy only, never a raw server or network string (use
 *   `errorMessage()` from clientFetch for failures).
 * - One toast is visible at a time; a new one replaces the current one.
 * - Auto-dismiss: 4 s (error 6 s; 6 s as well when there is an action, so
 *   "Kumoa" can be reached). `durationMs: 0` keeps it until dismissed.
 * - A success toast fires `hapticNotify("success")`, an error toast
 *   `hapticNotify("error")`, unless `haptic: false`.
 * - Undo pattern: do the soft change at once, show the toast with a "Kumoa"
 *   action, and commit for real in `onDismiss` when `reason !== "action"`.
 */

export type ToastTone = "success" | "error" | "info";

export type ToastAction = {
  /** Button label, e.g. "Kumoa". */
  label: string;
  onAction: () => void;
};

export type ToastDismissReason = "timeout" | "swipe" | "action" | "replaced" | "manual";

export type ToastOptions = {
  text: string;
  tone?: ToastTone;
  action?: ToastAction;
  /** Milliseconds before auto-dismiss; 0 = stays until dismissed. */
  durationMs?: number;
  /** Default true. */
  haptic?: boolean;
  /** Called once when the toast leaves, with the reason. */
  onDismiss?: (reason: ToastDismissReason) => void;
};

export type ToastRecord = {
  id: number;
  text: string;
  tone: ToastTone;
  action?: ToastAction;
  durationMs: number;
  haptic: boolean;
  onDismiss?: (reason: ToastDismissReason) => void;
};

type Listener = () => void;

let current: ToastRecord | null = null;
let nextId = 1;
const listeners = new Set<Listener>();

function emit() {
  for (const listener of listeners) listener();
}

export function defaultToastDuration(tone: ToastTone, hasAction: boolean): number {
  return tone === "error" || hasAction ? 6000 : 4000;
}

/** Shows a toast and returns a function that dismisses exactly this toast. */
export function showToast(options: ToastOptions): () => void {
  const tone = options.tone ?? "info";
  const record: ToastRecord = {
    id: nextId++,
    text: options.text,
    tone,
    action: options.action,
    durationMs: options.durationMs ?? defaultToastDuration(tone, Boolean(options.action)),
    haptic: options.haptic ?? true,
    onDismiss: options.onDismiss,
  };
  const previous = current;
  current = record;
  previous?.onDismiss?.("replaced");
  emit();
  return () => dismissToast(record.id, "manual");
}

/** Dismisses the visible toast (or only the one with `id`). */
export function dismissToast(id?: number, reason: ToastDismissReason = "manual"): void {
  if (!current) return;
  if (id !== undefined && current.id !== id) return;
  const leaving = current;
  current = null;
  emit();
  leaving.onDismiss?.(reason);
}

export function currentToast(): ToastRecord | null {
  return current;
}

export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resetToastsForTests(): void {
  current = null;
  nextId = 1;
  listeners.clear();
}
