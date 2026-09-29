"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui";

const EXIT_MS = 170;

/** The gap the bar floats above the tab bar (bottom offset, 0.75rem) plus breathing room. */
const CLEARANCE_PX = 12 + 8;

/**
 * The room the list needs at its end so the last row and "Katso kaikki" can
 * scroll clear of the bar. Published as a CSS variable on the root; the Kuitit
 * page reads it as bottom padding, so nothing changes while no bar is shown.
 */
export const BULK_BAR_SPACE_VAR = "--bulk-bar-space";

/**
 * The floating bar shown once one or more receipts are checkbox-selected.
 *
 * Deliberately NOT the `BottomActions` ds component: that one assumes the
 * tab bar is hidden (it only ever ships on `kind: "detail"` pages - see
 * AppShell's `isDetail`/`data-tabs="hidden"`), and sits at `z-30`, below the
 * tab bar's `z-50`. `/kuitit` keeps its tab bar, so this bar floats above it
 * (`z-55`).
 *
 * Motion (SHELL-13): slides up 220 ms on `--ease-drawer` (`.bottom-actions`)
 * and back down 160 ms when the selection clears, instead of popping. Under
 * reduced motion both are an opacity change only.
 */
export function BulkBar({
  visible,
  count,
  busy,
  onCancel,
  onDeleteRequest,
}: {
  visible: boolean;
  count: number;
  busy: boolean;
  onCancel: () => void;
  onDeleteRequest: () => void;
}) {
  const [mounted, setMounted] = useState(visible);
  const [leaving, setLeaving] = useState(false);
  const [prevVisible, setPrevVisible] = useState(visible);
  // The count the bar showed last, so it does not read "0 valittu" on its way out.
  const [shownCount, setShownCount] = useState(count);
  if (visible !== prevVisible) {
    setPrevVisible(visible);
    if (visible) {
      setMounted(true);
      setLeaving(false);
    } else {
      setLeaving(true);
    }
  }
  if (visible && count > 0 && count !== shownCount) setShownCount(count);

  const barRef = useRef<HTMLDivElement>(null);
  const shown = mounted && !leaving;
  useEffect(() => {
    if (!shown) return;
    const root = document.documentElement;
    const bar = barRef.current;
    if (!bar) return;
    const publish = () => root.style.setProperty(BULK_BAR_SPACE_VAR, `${Math.ceil(bar.offsetHeight) + CLEARANCE_PX}px`);
    publish();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(publish);
    observer?.observe(bar);
    return () => {
      observer?.disconnect();
      root.style.removeProperty(BULK_BAR_SPACE_VAR);
    };
  }, [shown]);

  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => {
      setMounted(false);
      setLeaving(false);
    }, EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [leaving]);

  if (!mounted) return null;

  return (
    <div
      className={`fixed inset-x-0 z-[55] flex justify-center px-4 md:left-[var(--app-sidebar-width,0px)] ${
        leaving ? "pointer-events-none" : ""
      }`}
      style={{ bottom: "calc(var(--app-tab-height) + var(--safe-bottom) + 0.75rem)" }}
      data-testid="bulk-bar"
    >
      <div
        ref={barRef}
        className="bottom-actions flex w-full max-w-sm items-center gap-3 rounded-card bg-ink px-4 py-2.5 text-canvas"
        style={{
          transition: "transform 160ms var(--ease-drawer), opacity 160ms var(--ease-out)",
          transform: leaving ? "translateY(calc(100% + 1rem))" : undefined,
          opacity: leaving ? 0 : undefined,
        }}
        role="toolbar"
        aria-label="Valitut kuitit"
      >
        <span className="text-caption font-medium" aria-live="polite">
          {shownCount} valittu
        </span>
        <div className="ml-auto flex gap-2">
          <Button type="button" variant="secondary" onClick={onCancel}>
            Peruuta
          </Button>
          <Button type="button" variant="danger" busy={busy} busyLabel="Poistetaan…" onClick={onDeleteRequest}>
            Poista
          </Button>
        </div>
      </div>
    </div>
  );
}
