"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useFocusTrap } from "@/components/useFocusTrap";
import { CONFIRM_FAILED, settleConfirm } from "@/lib/confirm-action";
import { isUserFacingMessage } from "@/components/clientFetch";
import { useOverlayLock } from "@/lib/overlay-lock";
import { subscribeOverlayClose } from "@/lib/screen-state";
import { Button } from "@/components/ui";
import { CircleHelp, TriangleAlert } from "lucide-react";
import { Icon } from "@/components/ds/Icon";
import { hapticNotify } from "@/lib/haptics";

interface ConfirmModalProps {
  isOpen: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
  isDestructive?: boolean;
}

/** Exit animation (CSS --dur-exit, 240 ms) plus a frame. */
const EXIT_MS = 250;

export default function ConfirmModal({
  isOpen,
  title,
  description,
  confirmLabel = "Poista",
  cancelLabel = "Peruuta",
  onConfirm,
  onCancel,
  isDestructive = true,
}: ConfirmModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const attemptRef = useRef(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Exit animation: stay mounted for one short slide-down after close.
  const [prevOpen, setPrevOpen] = useState(isOpen);
  const [closing, setClosing] = useState(false);
  if (isOpen !== prevOpen) {
    setPrevOpen(isOpen);
    setClosing(!isOpen);
    if (isOpen) {
      setBusy(false);
      setError("");
    }
  }

  function dismiss() {
    attemptRef.current += 1;
    setBusy(false);
    onCancel();
  }

  function confirm() {
    if (busy) return;
    const attempt = attemptRef.current + 1;
    attemptRef.current = attempt;
    setBusy(true);
    setError("");
    void settleConfirm(onConfirm).then((outcome) => {
      if (attemptRef.current !== attempt) return;
      setBusy(false);
      if (outcome.close) onCancel();
      // Raw server/network text never reaches the dialog (L5).
      else setError(isUserFacingMessage(outcome.message) ? outcome.message : CONFIRM_FAILED);
    });
  }

  useEffect(() => {
    if (!closing) return;
    // Exit: --dur-exit (240 ms) plus a frame.
    const timer = window.setTimeout(() => setClosing(false), EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [closing]);

  useFocusTrap(dialogRef, isOpen, { onEscape: dismiss });

  // C7 (IA-19): a destructive alert announces itself with the warning haptic.
  useEffect(() => {
    if (isOpen && isDestructive) void hapticNotify("warning");
  }, [isOpen, isDestructive]);
  useOverlayLock(isOpen);

  const cancelRef = useRef(onCancel);
  useLayoutEffect(() => {
    cancelRef.current = onCancel;
  });

  useEffect(() => {
    if (!isOpen) return;
    const close = () => {
      attemptRef.current += 1;
      setBusy(false);
      cancelRef.current();
    };
    const unsubscribe = subscribeOverlayClose(close);
    const onPop = () => close();
    window.addEventListener("popstate", onPop);
    return () => {
      unsubscribe();
      window.removeEventListener("popstate", onPop);
    };
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "unset";
    }
    return () => {
      document.body.style.overflow = "unset";
    };
  }, [isOpen]);

  if (!isOpen && !closing) return null;

  // A confirmation is the app's bottom sheet (anchored to the bottom edge,
  // above the tab bar, same canvas/shadow/backdrop as BottomSheet), not a
  // floating bubble in the middle of the screen. It keeps the alert-dialog
  // semantics: the backdrop never dismisses it (C3, IA-21) - the choice is
  // Peruuta or the action. `sheet-overlay` places it over the usable area and
  // inside the sidebar margin on desktop.
  return (
    <div
      className={`overlay-root sheet-overlay fixed inset-x-0 z-[80] ${
        closing ? "pointer-events-none" : "pointer-events-auto"
      }`}
      // A dialog animating out no longer counts as open (overlay-lock.ts).
      data-closing={closing || undefined}
    >
      {/* Backdrop. An alert is never dismissed by tapping outside it (C3,
          IA-21): the choice is Peruuta or the action. */}
      <div
        ref={overlayRef}
        className={`absolute inset-0 bg-ink/40 backdrop-blur-[2px] ${
          closing ? "animate-backdrop-out" : "animate-backdrop"
        }`}
        aria-hidden="true"
      />

      <div
        className={`sheet-wrap absolute inset-x-0 bottom-0 mx-auto w-full max-w-lg rounded-t-3xl shadow-2xl ${
          closing ? "animate-sheet-out" : "animate-sheet"
        }`}
      >
        <div className="sheet-bleed" aria-hidden />
        <div
          ref={dialogRef}
          className="sheet-panel stitch-page relative flex max-h-[85dvh] flex-col overflow-hidden rounded-t-3xl bg-canvas"
          // R6 / AX-23: a destructive confirm is an alert dialog.
          role={isDestructive ? "alertdialog" : "dialog"}
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={description ? descriptionId : undefined}
          tabIndex={-1}
        >
          <div className="sheet-body">
            <div className="flex flex-col items-center px-6 pt-8 text-center">
              {isDestructive ? (
                <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-danger/10 text-danger">
                  <Icon icon={TriangleAlert} size="hero" />
                </div>
              ) : (
                <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-accent-soft text-accent">
                  <Icon icon={CircleHelp} size="hero" />
                </div>
              )}

              <h2 id={titleId} className="text-headline font-semibold text-ink">{title}</h2>

              {description && (
                <p id={descriptionId} className="mt-2 text-sm text-ink-2">{description}</p>
              )}

              {error && (
                <p className="mt-3 text-sm text-danger" role="alert">
                  {error}
                </p>
              )}
            </div>

            <div className="mt-6 flex w-full gap-3 px-6 pb-2 sheet-safe-bottom">
              <Button type="button" variant="secondary" className="flex-1" onClick={dismiss}>
                {cancelLabel}
              </Button>
              <Button
                type="button"
                variant={isDestructive ? "danger" : "primary"}
                className="flex-1"
                onClick={confirm}
                haptic={isDestructive ? "medium" : "light"}
                busy={busy}
                busyLabel="Odota…"
              >
                {confirmLabel}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
