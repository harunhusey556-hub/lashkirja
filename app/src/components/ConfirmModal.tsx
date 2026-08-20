"use client";

import { useEffect, useRef, useState } from "react";
import { useFocusTrap } from "@/components/useFocusTrap";

interface ConfirmModalProps {
  isOpen: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
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

  // Exit animation: stay mounted for one short fade/scale-down after close.
  const [prevOpen, setPrevOpen] = useState(isOpen);
  const [closing, setClosing] = useState(false);
  if (isOpen !== prevOpen) {
    setPrevOpen(isOpen);
    setClosing(!isOpen);
  }

  useEffect(() => {
    if (!closing) return;
    const timer = window.setTimeout(() => setClosing(false), 180);
    return () => window.clearTimeout(timer);
  }, [closing]);

  useFocusTrap(dialogRef, isOpen, { onEscape: onCancel });

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
      className={`fixed inset-0 z-50 flex items-center justify-center px-4 ${
        closing ? "pointer-events-none" : ""
      }`}
    >
      {/* Backdrop */}
      <div
        ref={overlayRef}
        className={`absolute inset-0 bg-charcoal/60 ${
          closing ? "animate-backdrop-out" : "animate-fade-in"
        }`}
        onClick={(e) => {
          if (e.target === overlayRef.current) onCancel();
        }}
        aria-hidden="true"
      />

      <div
        ref={dialogRef}
        className={`relative bg-white rounded-3xl p-6 w-full max-w-sm shadow-2xl ${
          closing ? "animate-scale-out" : "animate-scale-in"
        }`}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex flex-col items-center text-center">
          {isDestructive ? (
            <div className="w-12 h-12 rounded-full bg-danger/10 flex items-center justify-center text-danger mb-4">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-6 h-6">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
          ) : (
            <div className="w-12 h-12 rounded-full bg-warning/10 flex items-center justify-center text-warning mb-4">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-6 h-6">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9 5.25h.008v.008H12v-.008z" />
              </svg>
            </div>
          )}
          
          <h3 className="text-lg font-medium text-charcoal">{title}</h3>
          
          {description && (
            <p className="mt-2 text-sm text-warm-gray">{description}</p>
          )}
          
          <div className="mt-6 flex w-full gap-3">
            <button
              type="button"
              onClick={onCancel}
              className="flex-1 py-3 rounded-xl border border-warm-gray-light text-sm font-medium text-charcoal hover:bg-cream transition-colors"
            >
              {cancelLabel}
            </button>
            <button
              type="button"
              onClick={() => {
                onConfirm();
                onCancel();
              }}
              className={`flex-1 py-3 rounded-xl text-sm font-medium text-white transition-colors ${
                isDestructive ? "bg-danger hover:bg-danger/90" : "bg-charcoal hover:bg-black"
              }`}
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
