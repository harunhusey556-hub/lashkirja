/**
 * How a send attempt reads in an invoice's Historia.
 *
 * An attempt that a server restart left in "sending" is later closed as
 * failed with a note of its own (CRASHED_SEND_NOTE). It was not refused by the
 * recipient's server: it was interrupted, and the mail may in fact have
 * reached the customer. Historia says that instead of the refusal text.
 * Raw mail-server errors are English and internal, so they are never shown.
 */

/** Stored on an attempt that the server closed after a crash. Kept in one place for the writer and the reader. */
export const CRASHED_SEND_NOTE = "Lähetys keskeytyi, kun palvelin käynnistyi uudelleen kesken lähetyksen.";

export interface SendAttemptView {
  title: string;
  /** What to add to the line, or null when the status says it all. */
  reason: string | null;
  tone: "accent" | "muted";
}

export function sendAttemptView(send: { status: string; error: string | null }): SendAttemptView {
  if (send.status === "sent") return { title: "Lähetetty sähköpostilla", reason: null, tone: "muted" };
  if (send.status === "failed") {
    if (send.error === CRASHED_SEND_NOTE) {
      return {
        title: "Lähetys keskeytyi",
        reason: "palvelin käynnistyi uudelleen kesken lähetyksen, viesti on voinut mennä perille",
        tone: "accent",
      };
    }
    return {
      title: "Lähetys epäonnistui",
      reason: "vastaanottajan palvelin ei ottanut viestiä vastaan",
      tone: "accent",
    };
  }
  if (send.status === "ambiguous") {
    return {
      title: "Lähetys jäi epäselväksi",
      reason: "viesti lähti, mutta kirjausta ei saatu tallennettua",
      tone: "accent",
    };
  }
  return { title: "Lähetys kesken", reason: null, tone: "muted" };
}
