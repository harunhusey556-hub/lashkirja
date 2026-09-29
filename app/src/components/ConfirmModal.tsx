"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useFocusTrap } from "@/components/useFocusTrap";
import { CONFIRM_FAILED, settleConfirm } from "@/lib/confirm-action";
import { isUserFacingMessage } from "@/components/clientFetch";
import { useOverlayLock } from "@/lib/overlay-lock";
import { subscribeOverlayClose } from "@/lib/screen-state";
import { Button } from "@/components/ui";
import { CircleHelp, TriangleAlert } from "lucide-react";
import { Icon } from "@/components/ds/Icon";

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

  // Exit animation: stay mounted for one short fade/scale-down after close.
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
    // Exit: --dur-pop (150 ms) plus a frame.
    const timer = window.setTimeout(() => setClosing(false), 160);
    return () => window.clearTimeout(timer);
  }, [closing]);

  useFocusTrap(dialogRef, isOpen, { onEscape: dismiss });
  useOverlayLock(isOpen);

  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;

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

  return (
    <div
      className={`overlay-root fixed inset-0 z-[80] flex items-center justify-center px-4 ${
        closing ? "pointer-events-none" : "pointer-events-auto"
      }`}
    >
      {/* Backdrop */}
      <div
        ref={overlayRef}
        className={`absolute inset-0 bg-ink/50 ${
          closing ? "animate-backdrop-out" : "animate-fade-in"
        }`}
        onClick={(e) => {
          if (e.target === overlayRef.current) dismiss();
        }}
        aria-hidden="true"
      />

      <div
        ref={dialogRef}
        className={`relative bg-surface rounded-3xl p-6 w-full max-w-sm shadow-2xl ${
          closing ? "animate-scale-out" : "animate-scale-in"
        }`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
      >
        <div className="flex flex-col items-center text-center">
          {isDestructive ? (
            <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-danger/10 text-danger">
              <Icon icon={TriangleAlert} size="hero" />
            </div>
          ) : (
            <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-accent-soft text-accent">
              <Icon icon={CircleHelp} size="hero" />
            </div>
          )}

          <h3 id={titleId} className="text-headline font-semibold text-ink">{title}</h3>

          {description && (
            <p id={descriptionId} className="mt-2 text-sm text-ink-2">{description}</p>
          )}

          {error && (
            <p className="mt-3 text-sm text-danger" role="alert">
              {error}
            </p>
          )}
          
          <div className="mt-6 flex w-full gap-3">
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
  );
}
