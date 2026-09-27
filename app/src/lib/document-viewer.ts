export const ZOOM_STEPS = [1, 1.5, 2] as const;

export type ZoomStep = (typeof ZOOM_STEPS)[number];

export function nextZoom(current: number): ZoomStep {
  const index = ZOOM_STEPS.findIndex((step) => step === current);
  const next = ZOOM_STEPS[(index + 1) % ZOOM_STEPS.length];
  return next ?? ZOOM_STEPS[0];
}

export function nextRotation(current: number): number {
  const normalized = ((current % 360) + 360) % 360;
  return (normalized + 90) % 360;
}
