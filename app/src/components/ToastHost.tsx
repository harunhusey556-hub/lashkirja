"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { CircleAlert, CircleCheck, Info, type LucideIcon } from "lucide-react";
import { Icon } from "@/components/ds/Icon";
import { hapticNotify } from "@/lib/haptics";
import {
  currentToast,
  dismissToast,
  subscribeToasts,
  type ToastRecord,
  type ToastTone,
} from "@/lib/toast";

const TONE_ICON: Record<ToastTone, LucideIcon> = {
  success: CircleCheck,
  error: CircleAlert,
  info: Info,
};

const EXIT_MS = 160;

/**
 * Renders the toast from `lib/toast.ts`. Mounted once, inside `.app-frame`
 * (AppShell). Motion uses CSS transitions, not keyframes, so a toast that
 * is replaced or swiped mid-animation retargets from where it is.
 */
export function ToastHost() {
  const toast = useSyncExternalStore(subscribeToasts, currentToast, () => null);
  // The toast that is sliding out after being dismissed or replaced.
  const [leaving, setLeaving] = useState<ToastRecord | null>(null);
  const [shown, setShown] = useState<ToastRecord | null>(toast);
  if (shown !== toast) {
    if (shown) setLeaving(shown);
    setShown(toast);
  }

  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => setLeaving(null), EXIT_MS + 20);
    return () => window.clearTimeout(timer);
  }, [leaving]);

  useEffect(() => {
    if (!toast || !toast.haptic) return;
    if (toast.tone === "success") void hapticNotify("success");
    else if (toast.tone === "error") void hapticNotify("error");
  }, [toast]);

  return (
    <div className="toast-viewport" aria-live="polite" aria-relevant="additions">
      {leaving && leaving.id !== toast?.id && <ToastItem key={leaving.id} toast={leaving} leaving />}
      {toast && <ToastItem key={toast.id} toast={toast} leaving={false} />}
    </div>
  );
}

function ToastItem({ toast, leaving }: { toast: ToastRecord; leaving: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [entered, setEntered] = useState(false);

  // One frame at the start position, then transition to rest.
  useEffect(() => {
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  // Auto-dismiss, paused while a finger is on the toast.
  const holdRef = useRef(false);
  useEffect(() => {
    if (leaving || toast.durationMs <= 0) return;
    let timer = 0;
    const arm = (ms: number) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        // Still held: give the finger another moment instead of yanking it away.
        if (holdRef.current) arm(1500);
        else dismissToast(toast.id, "timeout");
      }, ms);
    };
    arm(toast.durationMs);
    return () => window.clearTimeout(timer);
  }, [leaving, toast.id, toast.durationMs]);

  // Swipe down to dismiss.
  useEffect(() => {
    const el = ref.current;
    if (!el || leaving) return;
    let startY = 0;
    let startT = 0;
    let dy = 0;
    let tracking = false;
    const onDown = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest("button")) return;
      tracking = true;
      holdRef.current = true;
      startY = event.clientY;
      startT = performance.now();
      dy = 0;
      el.style.transition = "none";
    };
    const onMove = (event: PointerEvent) => {
      if (!tracking) return;
      const raw = event.clientY - startY;
      // Down follows the finger; up resists.
      dy = raw >= 0 ? raw : -(-raw * 12) / (-raw + 12);
      el.style.transform = `translateY(${dy}px)`;
    };
    const onUp = () => {
      if (!tracking) return;
      tracking = false;
      holdRef.current = false;
      const velocity = dy / Math.max(performance.now() - startT, 1);
      el.style.transition = "";
      if (dy > 36 || (dy > 8 && velocity > 0.11)) {
        el.style.transform = "";
        dismissToast(toast.id, "swipe");
      } else {
        el.style.transform = "";
      }
    };
    el.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [leaving, toast.id]);

  const state = leaving ? "exit" : entered ? "open" : "enter";

  return (
    <div
      ref={ref}
      className="toast"
      data-state={state}
      data-tone={toast.tone}
      role={toast.tone === "error" ? "alert" : "status"}
      aria-hidden={leaving || undefined}
    >
      <Icon icon={TONE_ICON[toast.tone]} className="shrink-0 text-canvas/80" />
      <p className="min-w-0 flex-1 text-[15px] leading-snug">{toast.text}</p>
      {toast.action && (
        <button
          type="button"
          onClick={() => {
            toast.action?.onAction();
            dismissToast(toast.id, "action");
          }}
          className="-my-2 -mr-2 min-h-11 min-w-11 shrink-0 rounded-card px-3 text-[15px] font-semibold text-accent-soft"
        >
          {toast.action.label}
        </button>
      )}
    </div>
  );
}
