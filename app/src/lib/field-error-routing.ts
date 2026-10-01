/**
 * Where a refusal that names fields goes (F64, C-5). A form renders an error
 * slot only for some fields; a refusal about a field with no slot (a date, the
 * VAT rows) must not vanish. The generic message is dropped only when at least
 * one named field has a slot to show it, otherwise the first message is the
 * generic one.
 */
export function routeFieldErrors(
  fields: Record<string, string>,
  hasSlot: (key: string) => boolean
): { fields: Record<string, string>; message: string } {
  const keys = Object.keys(fields);
  if (keys.length === 0) return { fields: {}, message: "" };
  if (keys.some(hasSlot)) return { fields, message: "" };
  return { fields: {}, message: fields[keys[0]] };
}
