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

export function invalidFieldProps(id: string, error?: string, hintId?: string) {
  return {
    id,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": error ? `${id}-error` : hintId,
  };
}
