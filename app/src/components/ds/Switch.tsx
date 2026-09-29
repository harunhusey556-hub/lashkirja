"use client";

import { hapticSelection } from "@/lib/haptics";

/**
 * The one on/off switch (IA-18, C7): the iOS 51 x 31 pt track with a 27 pt
 * knob that slides by transform (never `left`), a selection haptic when the
 * value changes, no press scale (globals.css excludes role=switch), and a
 * hit area of at least 44 pt (the ::after bleed). State is not colour
 * alone: the knob position carries it too (R15).
 */
export function Switch({
  checked,
  onChange,
  label,
  disabled = false,
  className = "",
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Accessible name; the visible label beside the switch, or an equivalent. */
  label: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => {
        void hapticSelection();
        onChange(!checked);
      }}
      className={`ds-switch relative h-[31px] w-[51px] shrink-0 rounded-full transition-colors duration-200 ease-out after:absolute after:-inset-[7px] after:content-[''] disabled:opacity-50 ${
        checked ? "bg-accent" : "bg-line"
      } ${className}`}
    >
      <span
        aria-hidden
        className={`absolute left-[2px] top-[2px] h-[27px] w-[27px] rounded-full bg-surface shadow-[0_2px_6px_rgb(0_0_0/0.18)] transition-transform duration-200 ease-out ${
          checked ? "translate-x-[20px]" : "translate-x-0"
        }`}
      />
    </button>
  );
}
