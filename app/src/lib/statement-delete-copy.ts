/**
 * What a delete dialog on a tiliote or a bank row tells the owner. It only
 * mentions an invoice or a sale proposal when one is really involved, so a
 * plain expense row is not told that "the invoice stays paid".
 */

export interface DeleteFacts {
  /** The row paid a sales invoice (the invoice stays paid, an approved sale of it is rejected). */
  settlesInvoice: boolean;
  /** A sale proposal made from the row still waits for approval and goes with it. */
  pendingSale: boolean;
}

const INVOICE_STAYS_PAID =
  "Lasku jää maksetuksi, ja siitä tehty hyväksytty myynti merkitään hylätyksi, jotta myynti ei tuplaannu.";

export function deleteRowDescription(facts: DeleteFacts): string {
  return [
    "Tapahtuma poistetaan pysyvästi.",
    facts.pendingSale ? "Siitä tehty hyväksymätön myyntiehdotus poistuu myös." : "",
    facts.settlesInvoice ? `Tapahtuma on maksanut laskun. ${INVOICE_STAYS_PAID}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function deleteStatementDescription(fileName: string, rows: DeleteFacts[]): string {
  const sales = rows.some((row) => row.pendingSale);
  const invoices = rows.some((row) => row.settlesInvoice);
  return [
    `"${fileName}" ja kaikki sen tapahtumat poistetaan pysyvästi.`,
    sales ? "Niistä tehdyt hyväksymättömät myyntiehdotukset poistuvat myös." : "",
    invoices ? `Osa tapahtumista on maksanut laskuja. ${INVOICE_STAYS_PAID}` : "",
    "Tätä ei voi perua.",
  ]
    .filter(Boolean)
    .join(" ");
}
