"use client";

import { cloneElement, isValidElement, useId, type ButtonHTMLAttributes, type ReactElement, type ReactNode } from "react";
import { buttonClass, type ButtonVariant } from "@/components/control-styles";
import { invalidFieldProps } from "@/lib/focus-field";
import { hapticImpact, type HapticImpactStyle } from "@/lib/haptics";
import { Reveal } from "@/components/ds/Reveal";

export { buttonClass, chipClass, controlClass } from "@/components/control-styles";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  busy?: boolean;
  busyLabel?: string;
  /** Native form posts must stay enabled or the browser drops the submit. */
  allowBusySubmit?: boolean;
  variant?: ButtonVariant;
  /** Shown when the control is disabled, so the reason is not only a tooltip. */
  disabledReason?: string;
  /** Native tap on click. Default: light impact for primary and danger, none otherwise. */
  haptic?: HapticImpactStyle | false;
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
  haptic,
  type = "button",
  onClick,
  ...props
}: ButtonProps) {
  const impact = haptic ?? (variant === "primary" || variant === "danger" ? "light" : false);
  const isBusy = busy;
  const isDisabled = Boolean(disabled || (isBusy && !allowBusySubmit));
  const reasonId = useId();
  const showReason = Boolean(isDisabled && disabledReason && !isBusy);
  return (
    <button
      type={type}
      {...props}
      onClick={(event) => {
        if (impact) void hapticImpact(impact);
        onClick?.(event);
      }}
      disabled={isDisabled}
      aria-busy={isBusy || undefined}
      aria-describedby={showReason ? reasonId : props["aria-describedby"]}
      title={showReason ? disabledReason : props.title}
      className={buttonClass(variant, className)}
    >
      {/* The label and the busy state share one grid cell, and the one not
          shown keeps its room: the button never changes width mid-save. */}
      <span className="grid place-items-center">
        <span className={`col-start-1 row-start-1 inline-flex items-center justify-center gap-2 ${isBusy ? "invisible" : ""}`}>
          {showReason ? (
            <span className="flex flex-col items-center leading-tight">
              <span>{children}</span>
              <span id={reasonId} className="text-micro font-normal opacity-80">
                {disabledReason}
              </span>
            </span>
          ) : (
            children
          )}
        </span>
        {busyLabel || isBusy ? (
          <span
            aria-hidden={!isBusy || undefined}
            className={`col-start-1 row-start-1 inline-flex items-center justify-center gap-2 ${isBusy ? "" : "invisible"}`}
          >
            <span
              className="h-4 w-4 shrink-0 rounded-full border-2 border-current border-t-transparent animate-spin motion-reduce:animate-none"
              aria-hidden
            />
            {busyLabel}
          </span>
        ) : null}
      </span>
    </button>
  );
}

export function Field({
  label,
  action,
  htmlFor,
  hint,
  error,
  optional = false,
  children,
}: {
  label: string;
  action?: ReactNode;
  htmlFor: string;
  hint?: string;
  error?: string;
  /** R23: an optional field says so ("(valinnainen)"); a required one carries no mark and no asterisk. */
  optional?: boolean;
  children: ReactNode;
}) {
  const hintId = hint && !error ? `${htmlFor}-hint` : undefined;
  const a11y = invalidFieldProps(htmlFor, error, hintId);
  const control = isValidElement(children)
    ? cloneElement(children as ReactElement<Record<string, unknown>>, a11y)
    : children;
  return (
    <div>
      {action ? (
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <label htmlFor={htmlFor} className="text-caption font-normal text-ink-2">
            {label}{optional ? " (valinnainen)" : null}
          </label>
          {action}
        </div>
      ) : (
      <label htmlFor={htmlFor} className="mb-1.5 block text-caption font-normal text-ink-2">
        {label}
        {optional ? " (valinnainen)" : null}
      </label>
      )}
      {control}
      {/* The line under a field unfolds instead of pushing the form down in one frame. */}
      <Reveal show={Boolean(error || hint)}>
        {error ? (
          <p id={`${htmlFor}-error`} className="mt-1.5 text-caption text-danger" role="alert">
            {error}
          </p>
        ) : (
          <p id={hintId} className="mt-1.5 text-caption text-ink-2">
            {hint}
          </p>
        )}
      </Reveal>
    </div>
  );
}

export function FormError({ message, className = "" }: { message: string; className?: string }) {
  return (
    <Reveal show={Boolean(message)}>
      <p className={`text-caption text-danger ${className}`} role="alert">
        {message}
      </p>
    </Reveal>
  );
}

export function SavePhaseNote({
  phase,
  error = "",
}: {
  phase: "clean" | "dirty" | "saving" | "saved" | "failed";
  error?: string;
}) {
  // One line that changes its words in place; it only unfolds and folds when
  // the form goes from clean to edited and back.
  return (
    <Reveal show={phase !== "clean"}>
      <SavePhaseText phase={phase} error={error} />
    </Reveal>
  );
}

function SavePhaseText({ phase, error }: { phase: "clean" | "dirty" | "saving" | "saved" | "failed"; error: string }) {
  if (phase === "saving") {
    return (
      <p className="text-caption text-ink-2" role="status">
        Tallennetaan…
      </p>
    );
  }
  if (phase === "saved") {
    return (
      <p className="text-caption text-success" role="status">
        Tallennettu
      </p>
    );
  }
  if (phase === "failed") {
    return (
      <p className="text-caption text-danger" role="alert">
        {error || "Tallennus epäonnistui"}
      </p>
    );
  }
  if (phase === "dirty") {
    return (
      <p className="text-caption text-ink-2" role="status">
        Tallentamattomia muutoksia
      </p>
    );
  }
  return null;
}

export function SavedNote({ message, className = "" }: { message: string; className?: string }) {
  return (
    <Reveal show={Boolean(message)}>
      <p className={`text-caption text-success ${className}`} role="status">
        {message}
      </p>
    </Reveal>
  );
}
