"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  busy?: boolean;
  busyLabel?: string;
  /** Native form posts must stay enabled or the browser drops the submit. */
  allowBusySubmit?: boolean;
  variant?: "primary" | "secondary" | "danger" | "ghost";
};

const VARIANTS: Record<NonNullable<ButtonProps["variant"]>, string> = {
  primary: "bg-accent text-white hover:bg-accent-dark",
  secondary: "bg-white text-charcoal border border-warm-gray-light/70 hover:bg-cream",
  danger: "bg-white text-danger border border-danger/30 hover:bg-danger/5",
  ghost: "bg-transparent text-charcoal hover:bg-cream",
};

/**
 * Pressed state is painted by the global pointerdown listener (data-pressed)
 * before this click handler, and therefore before any network request.
 * `busy` is the optimistic in-flight state after the tap has already landed.
 */
export function Button({
  busy = false,
  busyLabel,
  allowBusySubmit = false,
  variant = "primary",
  className = "",
  children,
  disabled,
  type = "button",
  ...props
}: ButtonProps) {
  const isBusy = busy;
  return (
    <button
      type={type}
      {...props}
      disabled={disabled || (isBusy && !allowBusySubmit)}
      aria-busy={isBusy || undefined}
      className={`active-press inline-flex min-h-12 items-center justify-center gap-2 rounded-xl px-4 text-sm font-medium transition-colors disabled:opacity-60 ${VARIANTS[variant]} ${className}`}
    >
      {isBusy && (
        <span
          className="h-4 w-4 rounded-full border-2 border-current border-t-transparent animate-spin motion-reduce:animate-none"
          aria-hidden
        />
      )}
      {isBusy && busyLabel ? busyLabel : children}
    </button>
  );
}

export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1.5 block text-sm font-medium text-charcoal-light">
        {label}
      </label>
      {children}
      {hint && !error && <p className="mt-1.5 text-xs text-warm-gray">{hint}</p>}
      {error && (
        <p id={`${htmlFor}-error`} className="mt-1.5 text-sm text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function FormError({ message, className = "" }: { message: string; className?: string }) {
  if (!message) return null;
  return (
    <p className={`text-sm text-danger ${className}`} role="alert">
      {message}
    </p>
  );
}

export function SavedNote({ message, className = "" }: { message: string; className?: string }) {
  if (!message) return null;
  return (
    <p className={`text-sm text-success ${className}`} role="status">
      {message}
    </p>
  );
}
