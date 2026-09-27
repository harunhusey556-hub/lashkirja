/** Overall or per-field score below this is shown as uncertain. */
export const LOW_CONFIDENCE = 0.55;

export function isLowConfidenceField(input: {
  value: string;
  overall: number | null | undefined;
  field?: number | null;
}): boolean {
  if (!input.value.trim()) return true;
  if (input.field != null && Number.isFinite(input.field)) return input.field < LOW_CONFIDENCE;
  if (input.overall != null && Number.isFinite(input.overall)) return input.overall < LOW_CONFIDENCE;
  return false;
}
