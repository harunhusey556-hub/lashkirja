"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type InputHTMLAttributes,
} from "react";
import { Eye, EyeOff } from "lucide-react";
import { controlClass } from "@/components/control-styles";
import { Icon } from "@/components/ds/Icon";
import { hapticSelection } from "@/lib/haptics";

export const SHOW_PASSWORD_LABEL = "Näytä salasana";
export const HIDE_PASSWORD_LABEL = "Piilota salasana";

/** What the user had in the field before the eye was tapped. */
export interface FieldSelection {
  start: number;
  end: number;
  focused: boolean;
}

type SelectableField = Pick<HTMLInputElement, "value" | "selectionStart" | "selectionEnd">;
type FocusableField = Pick<HTMLInputElement, "focus" | "setSelectionRange">;

/** Reads the caret and selection; `focused` says the field had focus when the eye was pressed. */
export function captureSelection(input: SelectableField | null, focused: boolean): FieldSelection {
  return {
    start: input?.selectionStart ?? input?.value.length ?? 0,
    end: input?.selectionEnd ?? input?.value.length ?? 0,
    focused,
  };
}

/** Puts focus and the selection back after the input's type flipped; a field that was not focused stays so. */
export function restoreSelection(input: FocusableField | null, saved: FieldSelection): void {
  if (!input || !saved.focused) return;
  input.focus({ preventScroll: true });
  try {
    input.setSelectionRange(saved.start, saved.end);
  } catch {
    // Some input types refuse a selection; the value is unaffected.
  }
}

/**
 * Whether the input had focus when the eye was activated. A pointer click
 * trusts the hint taken at press time, because the tap itself can blur the
 * input first. A keyboard or assistive-technology activation sends no
 * pointerdown, so a hint left by an earlier aborted press is stale and ignored (V50).
 */
export function wasInputFocused({
  pressHint,
  inputIsActive,
  fromKeyboard,
}: {
  pressHint: boolean;
  inputIsActive: boolean;
  fromKeyboard: boolean;
}): boolean {
  return inputIsActive || (!fromKeyboard && pressHint);
}

type PasswordFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "id"> & {
  /** Input id; also the label's `htmlFor`. */
  id: string;
  /** Visible label (QUALITY-BAR F3: never placeholder-only). */
  label: string;
  /** Inline error under the field, `role="alert"`. */
  error?: string;
  /** Helper line under the field while there is no error. */
  hint?: string;
  /** Extra classes for the input. */
  inputClassName?: string;
  /** Accessible names of the eye button, for a field that is not a password (a PIN). */
  showLabel?: string;
  hideLabel?: string;
};

/**
 * The one secret field (QUALITY-BAR F1, OWN-01): a label, the input, and an
 * eye toggle with a 44 px target ("Näytä salasana" / "Piilota salasana").
 *
 * - Toggling keeps focus and the caret: the button never takes focus from the
 *   input (mouse down is cancelled), and the selection is put back after the
 *   input's `type` flips. The pointer events themselves are never cancelled:
 *   a cancelled touch pointerdown suppresses the click in WebKit, and the eye
 *   would not react to a tap (F07).
 * - Works controlled (`value`/`onChange`) and uncontrolled (a forwarded ref,
 *   as the login form reads it).
 * - Autofill hints stay on the input: pass `autoComplete` (`current-password`
 *   or `new-password`); capitalisation, correction and spellcheck are off.
 * - The field re-hides when it unmounts; nothing about the reveal is stored.
 */
export const PasswordField = forwardRef<HTMLInputElement, PasswordFieldProps>(function PasswordField(
  {
    id,
    label,
    error,
    hint,
    inputClassName = "",
    showLabel = SHOW_PASSWORD_LABEL,
    hideLabel = HIDE_PASSWORD_LABEL,
    className = "",
    style,
    "aria-describedby": describedByProp,
    ...inputProps
  },
  forwardedRef
) {
  const inputRef = useRef<HTMLInputElement>(null);
  useImperativeHandle(forwardedRef, () => inputRef.current as HTMLInputElement, []);
  const [visible, setVisible] = useState(false);
  // Whether the input had focus when the finger went down, for engines where the tap itself blurs it.
  const focusedAtPress = useRef(false);
  const frame = useRef(0);
  const hintId = useId();
  const errorId = `${id}-error`;

  const describedBy =
    [describedByProp, error ? errorId : hint ? hintId : undefined].filter(Boolean).join(" ") || undefined;

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const toggle = useCallback((fromKeyboard: boolean) => {
    const input = inputRef.current;
    const saved = captureSelection(
      input,
      wasInputFocused({
        pressHint: focusedAtPress.current,
        inputIsActive: typeof document !== "undefined" && document.activeElement === input,
        fromKeyboard,
      })
    );
    focusedAtPress.current = false;
    void hapticSelection();
    setVisible((current) => !current);
    // After the type flipped and painted, put focus and the selection back.
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => restoreSelection(inputRef.current, saved));
  }, []);

  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1.5 block text-caption font-normal text-ink-2">
        {label}
      </label>
      <div className="relative">
        <input
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          {...inputProps}
          ref={inputRef}
          id={id}
          type={visible ? "text" : "password"}
          aria-invalid={error ? true : inputProps["aria-invalid"]}
          aria-describedby={describedBy}
          className={`${controlClass}${error ? " !border-danger" : ""} ${inputClassName}`.trim()}
          // Inline: the eye's 48 px column must beat controlClass's px-3
          // whatever order the utilities land in.
          style={{ paddingRight: 48, ...style }}
        />
        <button
          type="button"
          // detail is 0 for a click that came from the keyboard or assistive technology.
          onClick={(event) => toggle(event.detail === 0)}
          // The button must not steal focus: the keyboard stays up and the
          // caret stays where it was. Only the mouse press is cancelled; the
          // pointer events stay alive so a touch tap still clicks (F07).
          onMouseDown={(event) => event.preventDefault()}
          onPointerDown={() => {
            focusedAtPress.current = document.activeElement === inputRef.current;
          }}
          onPointerCancel={() => {
            focusedAtPress.current = false;
          }}
          aria-label={visible ? hideLabel : showLabel}
          className="active-press absolute right-0 top-0.5 flex h-11 w-11 items-center justify-center text-ink-2"
        >
          <Icon icon={visible ? EyeOff : Eye} size="row" />
        </button>
      </div>
      {hint && !error && (
        <p id={hintId} className="mt-1.5 text-caption text-ink-2">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="mt-1.5 text-sm text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
});
