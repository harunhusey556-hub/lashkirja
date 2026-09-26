"use client";

import { useEffect, useRef } from "react";

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), img, [tabindex]:not([tabindex="-1"])';

interface UseFocusTrapOptions {
  /**
   * Called when Escape is pressed while the trap is active. Omit for modals
   * that must not be dismissable this way (e.g. a mandatory onboarding gate).
   */
  onEscape?: () => void;
  /** Focus this element first instead of the container's first focusable child. */
  initialFocusRef?: React.RefObject<HTMLElement | null>;
}

/**
 * Shared modal focus trap, extracted from `ReceiptPreview`'s original
 * implementation so every dialog/sheet in the app behaves the same way:
 *
 * - On open, moves focus into the container (to `initialFocusRef` if given,
 *   otherwise the first focusable element).
 * - While open, Tab/Shift+Tab cycles within the container instead of
 *   escaping to the page behind it.
 * - On close, restores focus to whatever element triggered the modal.
 */
export function useFocusTrap<T extends HTMLElement>(
  containerRef: React.RefObject<T | null>,
  active: boolean,
  options: UseFocusTrapOptions = {}
) {
  const { onEscape, initialFocusRef } = options;
  // Keep the effect's dependency list to just `active`+`containerRef`: the
  // callbacks are read through a ref so a caller passing a fresh inline
  // function every render doesn't re-run (and re-focus) the trap.
  const onEscapeRef = useRef(onEscape);
  const initialFocusRefRef = useRef(initialFocusRef);
  useEffect(() => {
    onEscapeRef.current = onEscape;
    initialFocusRefRef.current = initialFocusRef;
  }, [onEscape, initialFocusRef]);

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusables = () =>
      container
        ? Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
        : [];

    const toFocus = initialFocusRefRef.current?.current || focusables()[0] || container;
    toFocus?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onEscapeRef.current?.();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const current = document.activeElement as HTMLElement | null;
      if (e.shiftKey && current === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && current === last) {
        e.preventDefault();
        first.focus();
      } else if (!current || !items.includes(current)) {
        // Focus somehow ended up outside the container — pull it back in.
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus();
    };
  }, [active, containerRef]);
}
