/**
 * "Take a photo of a receipt" from any screen (TF-06, TF-08, FP-10).
 *
 * The camera belongs to the Lisää sheet in AppShell, which owns the native
 * picker and the hidden web file input. A screen asks for it with this event
 * instead of navigating to a form, so "Ota ensimmäinen kuva" on Koti and the
 * "Lisää kuva" pill of a bank row open the camera directly (QUALITY-BAR A1).
 *
 * The event is dispatched synchronously inside the tap handler, so the web
 * fallback's `input.click()` still runs inside the user gesture.
 */
export const CAPTURE_REQUEST_EVENT = "lashkirja-capture-receipt";

export interface CaptureRequest {
  /** The bank row the photo documents: the new receipt is linked to it. */
  transactionId?: string;
  /** Who the row is (for the toast): "Ripsitukku Oy". */
  label?: string;
}

export function requestReceiptCapture(request: CaptureRequest = {}): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<CaptureRequest>(CAPTURE_REQUEST_EVENT, { detail: request }));
}
