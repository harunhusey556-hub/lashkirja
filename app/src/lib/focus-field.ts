/** First error key in the order the fields appear, else the first key at all. */
export function firstInvalidKey(
  errors: Record<string, string>,
  order: readonly string[] = []
): string | null {
  const ordered = order.find((key) => errors[key]);
  if (ordered) return ordered;
  const rest = Object.keys(errors);
  return rest[0] ?? null;
}

/**
 * Move focus to the first invalid control and keep its message associated.
 * `idFor` maps an error key to the input id when they differ.
 */
export function focusFirstInvalid(
  errors: Record<string, string>,
  order: readonly string[] = [],
  idFor: (key: string) => string = (key) => key
): string | null {
  const key = firstInvalidKey(errors, order);
  if (!key || typeof document === "undefined") return key;
  const element = document.getElementById(idFor(key));
  if (element instanceof HTMLElement) {
    element.focus();
    element.scrollIntoView({ block: "nearest" });
  }
  return key;
}

/**
 * `Field` merges this onto its child with `cloneElement`, which overwrites
 * matching props even when the new value is `undefined` (a key that exists
 * always wins, regardless of its value). So when there is no error and no
 * hint, `aria-invalid`/`aria-describedby` are left out of the returned
 * object entirely, not set to `undefined` - otherwise a caller that manages
 * its own `aria-invalid` directly on the child (e.g. a combined alert shared
 * by several fields, rather than Field's own per-field `error` text) would
 * have it silently clobbered back to unset on every render.
 */
export function invalidFieldProps(id: string, error?: string, hintId?: string) {
  const props: { id: string; "aria-invalid"?: true; "aria-describedby"?: string } = { id };
  if (error) {
    props["aria-invalid"] = true;
    props["aria-describedby"] = `${id}-error`;
  } else if (hintId) {
    props["aria-describedby"] = hintId;
  }
  return props;
}
