"use client";

import {
  forwardRef,
  useCallback,
  useId,
  useImperativeHandle,
  useLayoutEffect,
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
 *   input (pointer and mouse down are cancelled), and the selection is put
 *   back after the input's `type` flips.
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
  const caret = useRef<{ start: number; end: number; focused: boolean } | null>(null);
  const hintId = useId();
  const errorId = `${id}-error`;

  const describedBy =
    [describedByProp, error ? errorId : hint ? hintId : undefined].filter(Boolean).join(" ") || undefined;

  // After the type flips, restore focus and the selection the user had.
  useLayoutEffect(() => {
    const saved = caret.current;
    const input = inputRef.current;
    if (!saved || !input) return;
    caret.current = null;
    if (!saved.focused) return;
    input.focus({ preventScroll: true });
    try {
      input.setSelectionRange(saved.start, saved.end);
    } catch {
      // Some input types refuse a selection; the value is unaffected.
    }
  }, [visible]);

  const toggle = useCallback(() => {
    const input = inputRef.current;
    caret.current = {
      start: input?.selectionStart ?? input?.value.length ?? 0,
      end: input?.selectionEnd ?? input?.value.length ?? 0,
      focused: typeof document !== "undefined" && document.activeElement === input,
    };
    void hapticSelection();
    setVisible((current) => !current);
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
          onClick={toggle}
          // The button must not steal focus: the keyboard stays up and the
          // caret stays where it was.
          onMouseDown={(event) => event.preventDefault()}
          onPointerDown={(event) => {
            if (event.pointerType !== "mouse") event.preventDefault();
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
