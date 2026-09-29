"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { useFocusTrap } from "@/components/useFocusTrap";
import { Icon } from "@/components/ds/Icon";
import { useOverlayLock } from "@/lib/overlay-lock";
import { subscribeOverlayClose } from "@/lib/screen-state";
import { anyDirtySince, registeredSourceIds, requestLeave } from "@/lib/form-guard";

interface BottomSheetProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  subtitle?: string;
  /** Tailwind height class for the panel; sheets differ in how tall they need to be. */
  heightClass?: string;
  /** Rendered in the header row, right of the title. */
  headerAction?: React.ReactNode;
  children: React.ReactNode;
  labelledBy?: string;
  /**
   * Unsaved-changes guard for backdrop tap, swipe down, Escape and the close
   * button (SALES-27, QUALITY-BAR N5/F7). While dirty, those do not close the
   * sheet: it springs back and the app-wide discard prompt asks first
   * ("Hylätäänkö tallentamattomat muutokset?"); "Hylkää" then calls onClose.
   *
   * Omitted: the sheet is guarded automatically by every form-session dirty
   * source that registered after the sheet opened (the forms inside it).
   * `false` turns the guard off; `true` or a function forces it.
   */
  dirty?: boolean | (() => boolean);
}

/** Max upward lift, px. Beyond this the sheet resists asymptotically. */
const LIFT_LIMIT = 60;
/** Exit animation (CSS --dur-exit, 240 ms) plus a frame. */
const EXIT_MS = 250;

/** Asymptotic rubber band: approaches -LIFT_LIMIT, never reaches it. */
export function sheetDragOffset(moveY: number): number {
  if (moveY >= 0) return moveY;
  const pull = -moveY;
  return -(pull * LIFT_LIMIT) / (pull + LIFT_LIMIT);
}

/** Nearest scrollable element between `target` and `stop` (exclusive). */
function scrollableAncestor(target: Element | null, stop: Element): HTMLElement | null {
  let node: Element | null = target;
  while (node && node !== stop) {
    if (node instanceof HTMLElement) {
      const overflowY = getComputedStyle(node).overflowY;
      if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight + 1) {
        return node;
      }
    }
    node = node.parentElement;
  }
  return null;
}

/**
 * The one bottom sheet in the app.
 *
 * Everything a sheet has to get right on a phone lives here once: it never
 * grows past the visible viewport (dvh, not vh), it owns the home-indicator
 * inset, Escape, the backdrop and a swipe down close it (unless dirty), the
 * page behind it stops scrolling while it is open, and a lift past the rest
 * position resists and shows the sheet's own canvas underneath (bleed), never
 * the tab bar.
 */
export default function BottomSheet({
  isOpen,
  onClose,
  title,
  subtitle,
  heightClass = "max-h-[85dvh]",
  headerAction,
  children,
  labelledBy,
  dirty,
}: BottomSheetProps) {
  // Carries the transform (drag and slide); the panel inside clips content.
  const sheetRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const dragRegionRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLParagraphElement>(null);
  // True once a drag-down gesture has committed to closing the sheet. The
  // gesture already animated the sheet off-screen itself, so the CSS exit
  // animation must sit out for that close, or it would restart the slide
  // from translateY(0) and visibly jump back first.
  const [dragDismissed, setDragDismissed] = useState(false);
  const onCloseRef = useRef(onClose);
  const dirtyRef = useRef(dirty);
  useEffect(() => {
    onCloseRef.current = onClose;
    dirtyRef.current = dirty;
  });

  // Exit animation: closing keeps the sheet mounted for one slide-down, then
  // unmounts. Render-phase derived state so opening never renders a stale frame.
  const [prevOpen, setPrevOpen] = useState(isOpen);
  const [closing, setClosing] = useState(false);
  // Dirty sources that existed before this sheet opened belong to the page
  // behind it, not to the sheet. Taken while rendering the open, i.e. before
  // the forms inside the sheet run their effects and register.
  const [sourcesAtOpen, setSourcesAtOpen] = useState<Set<string>>(() =>
    isOpen ? registeredSourceIds() : new Set()
  );
  if (isOpen !== prevOpen) {
    setPrevOpen(isOpen);
    if (!isOpen) setClosing(true);
    else {
      setClosing(false);
      setDragDismissed(false);
      setSourcesAtOpen(registeredSourceIds());
    }
  }
  const sourcesAtOpenRef = useRef(sourcesAtOpen);
  useEffect(() => {
    sourcesAtOpenRef.current = sourcesAtOpen;
  }, [sourcesAtOpen]);

  useEffect(() => {
    if (!closing) return;
    const timer = window.setTimeout(() => setClosing(false), EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [closing]);

  const isDirtyNow = () => {
    const value = dirtyRef.current;
    if (typeof value === "function") return value();
    if (typeof value === "boolean") return value;
    return anyDirtySince(sourcesAtOpenRef.current);
  };

  /** Backdrop, Escape and the close button come through here (swipe too). */
  const attemptClose = () => {
    if (isDirtyNow()) requestLeave(() => onCloseRef.current());
    else onCloseRef.current();
  };

  useFocusTrap(sheetRef, isOpen, {
    onEscape: attemptClose,
    initialFocusRef: title ? titleRef : undefined,
  });

  // Drag to dismiss. From the handle/header row in both directions; from the
  // body only downward and only while the content under the finger is
  // scrolled to its top (SHELL-33), so scrollable content keeps its scroll.
  useEffect(() => {
    if (!isOpen) return;
    const sheet = sheetRef.current;
    const region = dragRegionRef.current;
    const backdrop = backdropRef.current;
    if (!sheet) return;

    let startX = 0;
    let startY = 0;
    let startTime = 0;
    let dy = 0;
    let sheetHeight = 0;
    let tracking = false;
    let decided = false;
    let fromRegion = false;
    let scroller: HTMLElement | null = null;
    let suppressClickUntil = 0;

    const clearInline = () => {
      sheet.style.transition = "";
      sheet.style.transform = "";
      if (backdrop) {
        backdrop.style.transition = "";
        backdrop.style.opacity = "";
      }
    };

    const springBack = () => {
      sheet.style.transition = "transform 280ms var(--ease-drawer)";
      sheet.style.transform = "translateY(0)";
      if (backdrop) {
        backdrop.style.transition = "opacity 200ms var(--ease-out)";
        backdrop.style.opacity = "1";
      }
      window.setTimeout(clearInline, 300);
    };

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        tracking = false;
        return;
      }
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      fromRegion = Boolean(region && target && region.contains(target));
      scroller = fromRegion ? null : scrollableAncestor(target, sheet);
      tracking = true;
      decided = false;
      dy = 0;
      startX = event.touches[0].clientX;
      startY = event.touches[0].clientY;
      startTime = performance.now();
      sheetHeight = sheet.offsetHeight || 1;
    };

    const onTouchMove = (event: TouchEvent) => {
      if (!tracking) return;
      const moveX = event.touches[0].clientX - startX;
      const moveY = event.touches[0].clientY - startY;
      if (!decided) {
        const vertical = Math.abs(moveY) >= Math.abs(moveX);
        if (!fromRegion) {
          const atTop = !scroller || scroller.scrollTop <= 0;
          if (!(atTop && vertical && moveY > 0)) {
            if (Math.abs(moveY) >= 6 || Math.abs(moveX) >= 6) tracking = false;
            return;
          }
          // Claim the gesture before the content starts its own bounce.
          event.preventDefault();
        }
        if (Math.abs(moveY) < 6 && Math.abs(moveX) < 6) return;
        if (!vertical) {
          tracking = false;
          return;
        }
        decided = true;
        sheet.style.transition = "none";
        if (backdrop) backdrop.style.transition = "none";
      }
      event.preventDefault();
      dy = sheetDragOffset(moveY);
      sheet.style.transform = `translateY(${dy}px)`;
      if (backdrop) {
        const progress = Math.max(0, Math.min(1, dy / (sheetHeight * 0.9)));
        backdrop.style.opacity = String(1 - progress);
      }
    };

    const onTouchEnd = () => {
      if (!tracking) return;
      tracking = false;
      if (!decided) return;
      // A drag that started on a row or button must not also tap it.
      suppressClickUntil = performance.now() + 400;
      const elapsed = Math.max(performance.now() - startTime, 1);
      const velocity = dy / elapsed;
      const commit = dy > 0 && (dy > sheetHeight * 0.35 || (dy > 80 && velocity > 0.5));

      if (!commit) {
        springBack();
        return;
      }
      if (isDirtyNow()) {
        springBack();
        requestLeave(() => onCloseRef.current());
        return;
      }
      setDragDismissed(true);
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (reduceMotion) {
        clearInline();
        onCloseRef.current();
        return;
      }
      sheet.style.transition = "transform var(--dur-exit) var(--ease-drawer)";
      sheet.style.transform = "translateY(100%)";
      if (backdrop) {
        backdrop.style.transition = "opacity 200ms var(--ease-out)";
        backdrop.style.opacity = "0";
      }
      window.setTimeout(() => onCloseRef.current(), 230);
    };

    const onClickCapture = (event: MouseEvent) => {
      if (performance.now() < suppressClickUntil) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    sheet.addEventListener("touchstart", onTouchStart, { passive: true });
    sheet.addEventListener("touchmove", onTouchMove, { passive: false });
    sheet.addEventListener("touchend", onTouchEnd);
    sheet.addEventListener("touchcancel", onTouchEnd);
    sheet.addEventListener("click", onClickCapture, true);
    return () => {
      sheet.removeEventListener("touchstart", onTouchStart);
      sheet.removeEventListener("touchmove", onTouchMove);
      sheet.removeEventListener("touchend", onTouchEnd);
      sheet.removeEventListener("touchcancel", onTouchEnd);
      sheet.removeEventListener("click", onClickCapture, true);
      clearInline();
    };
    // isDirtyNow reads refs only.
  }, [isOpen]);

  useOverlayLock(isOpen);

  // A route change closes every overlay; the navigation itself was already
  // guarded, so this closes directly.
  useEffect(() => {
    if (!isOpen) return;
    return subscribeOverlayClose(() => onCloseRef.current());
  }, [isOpen]);

  if (!isOpen && !closing) return null;

  const exitingViaDrag = closing && dragDismissed;

  // Above the tab bar (z-50). `overlay-root`: a page-level sheet renders
  // inside `.app-main`, which useOverlayLock makes pointer-events:none;
  // this class opts the sheet back in (see globals.css).
  return (
    <div className={`overlay-root sheet-overlay fixed inset-0 z-[60] ${closing ? "pointer-events-none" : ""}`}>
      <div
        ref={backdropRef}
        className={`absolute inset-0 bg-ink/40 backdrop-blur-[2px] ${
          exitingViaDrag ? "" : closing ? "animate-backdrop-out" : "animate-backdrop"
        }`}
        onClick={attemptClose}
        aria-hidden
      />

      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        // The shadow lives on this wrapper (not the panel) so the bleed, a
        // child painted above it, hides the shadow's lower edge during a lift.
        className={`absolute inset-x-0 bottom-0 mx-auto w-full max-w-lg rounded-t-3xl shadow-2xl ${
          exitingViaDrag ? "" : closing ? "animate-sheet-out" : "animate-sheet"
        }`}
      >
        <div className="sheet-bleed" aria-hidden />
        <div className={`relative flex flex-col overflow-hidden rounded-t-3xl bg-canvas ${heightClass}`}>
          <div ref={dragRegionRef} className="shrink-0">
            <div className="sheet-handle" aria-hidden />

            {(title || headerAction) && (
              <div className="flex items-center justify-between gap-3 pb-2 pl-5 pr-3 pt-1">
                <div className="min-w-0">
                  {title && (
                    <p
                      ref={titleRef}
                      id={labelledBy}
                      tabIndex={-1}
                      className="truncate text-title-3 font-bold tracking-[-0.01em] text-ink outline-none"
                    >
                      {title}
                    </p>
                  )}
                  {subtitle && <p className="mt-0.5 truncate text-caption text-ink-2">{subtitle}</p>}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {headerAction}
                  {/* 32px visual circle inside a 44px hit box. */}
                  <button
                    type="button"
                    onClick={attemptClose}
                    aria-label="Sulje"
                    className="active-press flex h-11 w-11 items-center justify-center"
                  >
                    <span className="flex h-8 w-8 items-center justify-center rounded-full bg-line/70 text-ink-2">
                      <Icon icon={X} size="inline" strokeWidth={2.25} />
                    </span>
                  </button>
                </div>
              </div>
            )}
          </div>

          {children}
        </div>
      </div>
    </div>
  );
}
