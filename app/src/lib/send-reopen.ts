/**
 * F22: the send sheet names what blocks a send (seller details, the customer's
 * e-mail) and links to where it is fixed. The link leaves the invoice, so the
 * sheet used to be gone on the way back and "Lähetä" had to be tapped again for
 * every blocker. The tap on the fix link leaves a short note here; the invoice
 * page that is opened next reopens the sheet once, for the same invoice.
 *
 * sessionStorage, not memory: the iOS shell can reload the webview while the
 * owner is in settings. A note older than ten minutes is ignored, so an
 * abandoned fix never opens a sheet unasked later.
 */
const KEY = "lashkirja.reopen-send";
export const SEND_REOPEN_MAX_AGE_MS = 10 * 60 * 1000;

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultStore(): Store | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function rememberSendReopen(invoiceId: string, now = Date.now(), store: Store | null = defaultStore()): void {
  try {
    store?.setItem(KEY, JSON.stringify({ invoiceId, at: now }));
  } catch {
    // Storage unavailable: the sheet simply does not reopen by itself.
  }
}

/** True once for the invoice the note was left for, then the note is gone. */
export function takeSendReopen(invoiceId: string, now = Date.now(), store: Store | null = defaultStore()): boolean {
  try {
    const raw = store?.getItem(KEY);
    if (!raw) return false;
    store?.removeItem(KEY);
    const note = JSON.parse(raw) as { invoiceId?: unknown; at?: unknown };
    return note.invoiceId === invoiceId && typeof note.at === "number" && now - note.at <= SEND_REOPEN_MAX_AGE_MS;
  } catch {
    return false;
  }
}
