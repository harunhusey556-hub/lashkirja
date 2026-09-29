"use client";

import { copyToClipboard } from "@/lib/clipboard";

/**
 * The "Kopioi" action for an identifier (IBAN, viite, Y-tunnus; AX-07, R25). It is a small text button;
 * the invisible `before` box grows the hit area to 44 pt without changing what is drawn. The accessible
 * name says what is copied ("Kopioi IBAN"), and the visible word "Kopioi" is part of it (WCAG 2.5.3).
 */
export function CopyButton({ text, what, className = "" }: { text: string; what: string; className?: string }) {
  return (
    <button
      type="button"
      aria-label={`Kopioi ${what}`}
      onClick={() => void copyToClipboard(text, what)}
      className={`active-press relative inline-flex min-h-6 shrink-0 items-center text-caption font-medium text-accent before:absolute before:-inset-x-2 before:-inset-y-3 before:content-[''] ${className}`}
    >
      Kopioi
    </button>
  );
}
