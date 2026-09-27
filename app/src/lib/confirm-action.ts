export const CONFIRM_FAILED = "Toiminto epäonnistui. Yritä uudelleen.";

export type ConfirmOutcome = { close: true } | { close: false; message: string };

/**
 * Run a confirm action that may be async.
 * Close only after it settles successfully. A throw keeps the dialog open
 * with the error message so the user can retry or dismiss.
 */
export async function settleConfirm(action: () => void | Promise<void>): Promise<ConfirmOutcome> {
  try {
    await action();
    return { close: true };
  } catch (error) {
    const message =
      error instanceof Error && error.message.trim() ? error.message : CONFIRM_FAILED;
    return { close: false, message };
  }
}
