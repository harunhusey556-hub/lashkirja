"use client";

import { cloneElement, isValidElement, useId, type ButtonHTMLAttributes, type ReactElement, type ReactNode } from "react";
import { buttonClass, type ButtonVariant } from "@/components/control-styles";
import { invalidFieldProps } from "@/lib/focus-field";

export { buttonClass, chipClass, controlClass } from "@/components/control-styles";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  busy?: boolean;
  busyLabel?: string;
  /** Native form posts must stay enabled or the browser drops the submit. */
  allowBusySubmit?: boolean;
  variant?: ButtonVariant;
  /** Shown when the control is disabled, so the reason is not only a tooltip. */
  disabledReason?: string;
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
  disabledReason,
  type = "button",
  ...props
}: ButtonProps) {
  const isBusy = busy;
  const isDisabled = Boolean(disabled || (isBusy && !allowBusySubmit));
  const reasonId = useId();
  const showReason = Boolean(isDisabled && disabledReason && !isBusy);
  return (
    <button
      type={type}
      {...props}
      disabled={isDisabled}
      aria-busy={isBusy || undefined}
      aria-describedby={showReason ? reasonId : props["aria-describedby"]}
      title={showReason ? disabledReason : props.title}
      className={buttonClass(variant, className)}
    >
      {isBusy && (
        <span
          className="h-4 w-4 rounded-full border-2 border-current border-t-transparent animate-spin motion-reduce:animate-none"
          aria-hidden
        />
      )}
      {isBusy && busyLabel ? (
        busyLabel
      ) : showReason ? (
        <span className="flex flex-col items-center leading-tight">
          <span>{children}</span>
          <span id={reasonId} className="text-[11px] font-normal opacity-80">
            {disabledReason}
          </span>
        </span>
      ) : (
        children
      )}
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
  const hintId = hint && !error ? `${htmlFor}-hint` : undefined;
  const a11y = invalidFieldProps(htmlFor, error, hintId);
  const control = isValidElement(children)
    ? cloneElement(children as ReactElement<Record<string, unknown>>, a11y)
    : children;
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1.5 block text-sm font-medium text-charcoal-light">
        {label}
      </label>
      {control}
      {hint && !error && (
        <p id={hintId} className="mt-1.5 text-xs text-warm-gray">
          {hint}
        </p>
      )}
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

export function SavePhaseNote({
  phase,
  error = "",
}: {
  phase: "clean" | "dirty" | "saving" | "saved" | "failed";
  error?: string;
}) {
  if (phase === "saving") {
    return (
      <p className="text-sm text-warm-gray" role="status">
        Tallennetaan…
      </p>
    );
  }
  if (phase === "saved") {
    return (
      <p className="text-sm text-success" role="status">
        Tallennettu
      </p>
    );
  }
  if (phase === "failed") {
    return <FormError message={error || "Tallennus epäonnistui"} />;
  }
  if (phase === "dirty") {
    return (
      <p className="text-sm text-warm-gray" role="status">
        Tallentamattomia muutoksia
      </p>
    );
  }
  return null;
}

export function SavedNote({ message, className = "" }: { message: string; className?: string }) {
  if (!message) return null;
  return (
    <p className={`text-sm text-success ${className}`} role="status">
      {message}
    </p>
  );
}
