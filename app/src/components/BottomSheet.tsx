"use client";

import { useEffect, useRef, useState } from "react";
import { useFocusTrap } from "@/components/useFocusTrap";
import { useOverlayLock } from "@/lib/overlay-lock";
import { subscribeOverlayClose } from "@/lib/screen-state";

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
}

/**
 * The one bottom sheet in the app.
 *
 * Everything a sheet has to get right on a phone lives here once: it never
 * grows past the visible viewport (dvh, not vh, so iOS toolbars cannot push
 * the bottom of it off screen), it owns the home-indicator inset, Escape and
 * the backdrop close it, and the page behind it stops scrolling while it is
 * open.
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
}: BottomSheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const dragRegionRef = useRef<HTMLDivElement>(null);
  // True once a drag-down gesture has committed to closing the sheet. The
  // gesture already animates the panel/backdrop to their final off-screen
  // state itself (following the finger's momentum), so the CSS exit
  // animation below must sit out entirely for that close — otherwise it
  // would restart the slide from `translateY(0)` (its keyframe `from`) and
  // the sheet would visibly jump back before playing the same animation the
  // drag already finished. State, not a ref: this has to be read while
  // rendering to decide which exit class (if any) to apply.
  const [dragDismissed, setDragDismissed] = useState(false);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  // Exit animation: closing keeps the sheet mounted for one short slide-down,
  // then unmounts. Derived-state-from-props pattern (render-phase setState)
  // instead of an effect, so opening never renders a stale frame.
  const [prevOpen, setPrevOpen] = useState(isOpen);
  const [closing, setClosing] = useState(false);
  if (isOpen !== prevOpen) {
    setPrevOpen(isOpen);
    if (!isOpen) setClosing(true);
    else {
      setClosing(false);
      setDragDismissed(false);
    }
  }

  useEffect(() => {
    if (!closing) return;
    const timer = window.setTimeout(() => setClosing(false), 220);
    return () => window.clearTimeout(timer);
  }, [closing]);

  useFocusTrap(panelRef, isOpen, { onEscape: onClose });

  // Drag-down-to-dismiss from the grabber handle / header row. Deliberately
  // scoped to that region rather than the whole panel so scrollable sheet
  // content (the "Lisää" menu, the AI chat transcript) keeps its own touch
  // scrolling untouched, and starting the drag from the close button or a
  // header action still taps it instead of dragging.
  useEffect(() => {
    if (!isOpen) return;
    const panel = panelRef.current;
    const region = dragRegionRef.current;
    const backdrop = backdropRef.current;
    if (!panel || !region) return;

    let startY = 0;
    let startTime = 0;
    let dy = 0;
    let panelHeight = 0;
    let tracking = false;
    let decided = false;

    const clearInline = () => {
      panel.style.transition = "";
      panel.style.transform = "";
      if (backdrop) {
        backdrop.style.transition = "";
        backdrop.style.opacity = "";
      }
    };

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) return;
      if (event.target instanceof Element && event.target.closest("button, a")) {
        return;
      }
      tracking = true;
      decided = false;
      dy = 0;
      startY = event.touches[0].clientY;
      startTime = performance.now();
      panelHeight = panel.offsetHeight || 1;
    };

    const onTouchMove = (event: TouchEvent) => {
      if (!tracking) return;
      const moveY = event.touches[0].clientY - startY;
      if (!decided) {
        if (Math.abs(moveY) < 6) return;
        decided = true;
        panel.style.transition = "none";
        if (backdrop) backdrop.style.transition = "none";
      }
      event.preventDefault();
      // Rubber-band: dragging up past the resting position resists instead
      // of moving the sheet 1:1 with the finger.
      dy = moveY >= 0 ? moveY : moveY / 4;
      panel.style.transform = `translateY(${dy}px)`;
      if (backdrop) {
        const progress = Math.max(0, Math.min(1, dy / (panelHeight * 0.9)));
        backdrop.style.opacity = String(1 - progress);
      }
    };

    const onTouchEnd = () => {
      if (!tracking) return;
      tracking = false;
      if (!decided) return;
      const elapsed = Math.max(performance.now() - startTime, 1);
      const velocity = dy / elapsed;
      const reduceMotion = window.matchMedia(
        "(prefers-reduced-motion: reduce)"
      ).matches;
      const commit =
        dy > 0 && (dy > panelHeight * 0.35 || (dy > 80 && velocity > 0.5));

      if (commit) {
        setDragDismissed(true);
        if (reduceMotion) {
          clearInline();
          onCloseRef.current();
          return;
        }
        panel.style.transition = "transform 0.22s cubic-bezier(0.32, 0.72, 0, 1)";
        panel.style.transform = "translateY(100%)";
        if (backdrop) {
          backdrop.style.transition = "opacity 0.2s ease-in";
          backdrop.style.opacity = "0";
        }
        window.setTimeout(() => onCloseRef.current(), 210);
      } else {
        panel.style.transition = "transform 0.28s cubic-bezier(0.32, 0.72, 0, 1)";
        panel.style.transform = "translateY(0)";
        if (backdrop) {
          backdrop.style.transition = "opacity 0.2s ease-out";
          backdrop.style.opacity = "1";
        }
        window.setTimeout(clearInline, 300);
      }
    };

    region.addEventListener("touchstart", onTouchStart, { passive: true });
    region.addEventListener("touchmove", onTouchMove, { passive: false });
    region.addEventListener("touchend", onTouchEnd);
    region.addEventListener("touchcancel", onTouchEnd);
    return () => {
      region.removeEventListener("touchstart", onTouchStart);
      region.removeEventListener("touchmove", onTouchMove);
      region.removeEventListener("touchend", onTouchEnd);
      region.removeEventListener("touchcancel", onTouchEnd);
      clearInline();
    };
  }, [isOpen]);

  useOverlayLock(isOpen);

  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!isOpen) return;
    return subscribeOverlayClose(() => closeRef.current());
  }, [isOpen]);

  if (!isOpen && !closing) return null;

  // A drag-dismiss already animated the panel/backdrop to their resting
  // closed state itself; the CSS exit classes must not also apply (see the
  // comment on dragDismissed above).
  const exitingViaDrag = closing && dragDismissed;

  // Above the tab bar (z-50): a sheet that the navigation paints over hides
  // its own bottom row - which is exactly where a composer or a save button
  // lives.
  return (
    <div className={`fixed inset-0 z-[60] ${closing ? "pointer-events-none" : ""}`}>
      <div
        ref={backdropRef}
        className={`absolute inset-0 bg-charcoal/40 backdrop-blur-[2px] ${
          exitingViaDrag ? "" : closing ? "animate-backdrop-out" : "animate-backdrop"
        }`}
        onClick={onClose}
        aria-hidden
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        className={`absolute inset-x-0 bottom-0 mx-auto w-full max-w-lg bg-white rounded-t-3xl shadow-2xl flex flex-col overflow-hidden ${
          exitingViaDrag ? "" : closing ? "animate-sheet-out" : "animate-sheet"
        } ${heightClass}`}
      >
        <div ref={dragRegionRef} className="shrink-0">
          <div className="sheet-handle" aria-hidden />

          {(title || headerAction) && (
            <div className="flex items-start justify-between gap-3 px-5 pt-2 pb-3 border-b border-warm-gray-light/30">
              <div className="min-w-0">
                {title && (
                  <p id={labelledBy} className="text-base font-medium text-charcoal truncate">
                    {title}
                  </p>
                )}
                {subtitle && <p className="text-xs text-warm-gray mt-0.5">{subtitle}</p>}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {headerAction}
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Sulje"
                  className="w-11 h-11 rounded-full flex items-center justify-center text-warm-gray hover:bg-warm-gray-light/30 transition-colors"
                >
                  <svg
                    className="w-5 h-5"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.75}
                    aria-hidden
                  >
                    <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
              </div>
            </div>
          )}
        </div>

        {children}
      </div>
    </div>
  );
}
