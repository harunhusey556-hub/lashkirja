"use client";

import { useEffect, useRef, useState } from "react";

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

  // Exit animation: closing keeps the sheet mounted for one short slide-down,
  // then unmounts. Derived-state-from-props pattern (render-phase setState)
  // instead of an effect, so opening never renders a stale frame.
  const [prevOpen, setPrevOpen] = useState(isOpen);
  const [closing, setClosing] = useState(false);
  if (isOpen !== prevOpen) {
    setPrevOpen(isOpen);
    if (!isOpen) setClosing(true);
    else setClosing(false);
  }

  useEffect(() => {
    if (!closing) return;
    const timer = window.setTimeout(() => setClosing(false), 220);
    return () => window.clearTimeout(timer);
  }, [closing]);

  useEffect(() => {
    if (!isOpen) return;

    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);

    // Freeze the page behind the sheet; otherwise a scroll gesture that starts
    // on the sheet keeps scrolling the list underneath it.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", handleKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [isOpen, onClose]);

  if (!isOpen && !closing) return null;

  // Above the tab bar (z-50): a sheet that the navigation paints over hides
  // its own bottom row - which is exactly where a composer or a save button
  // lives.
  return (
    <div className={`fixed inset-0 z-[60] ${closing ? "pointer-events-none" : ""}`}>
      <div
        className={`absolute inset-0 bg-charcoal/40 backdrop-blur-[2px] ${
          closing ? "animate-backdrop-out" : "animate-backdrop"
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
          closing ? "animate-sheet-out" : "animate-sheet"
        } ${heightClass}`}
      >
        <div className="sheet-handle shrink-0" aria-hidden />

        {(title || headerAction) && (
          <div className="flex items-start justify-between gap-3 px-5 pt-2 pb-3 border-b border-warm-gray-light/30 shrink-0">
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

        {children}
      </div>
    </div>
  );
}
