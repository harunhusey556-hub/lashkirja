/**
 * Finnish bank barcode (virtuaaliviivakoodi), version 4.
 *
 * 54 digits that let a payer scan an invoice into their bank instead of
 * typing IBAN, amount, reference and due date by hand:
 *
 *   1  version = 4
 *   16 IBAN without the "FI" prefix
 *   6  euros
 *   2  cents
 *   3  reserved, always zeros
 *   20 domestic reference, right-aligned and zero-padded
 *   6  due date as YYMMDD (zeros when there is none)
 *
 * Version 5 (RF references) is not produced here; an RF reference returns null
 * rather than a version-4 code that would be wrong.
 */
import { isValidIban, normalizeIban } from "./iban";
import { isValidReferenceNumber, normalizeReference } from "./finnish-reference";

export const BARCODE_LENGTH = 54;
/** Six digits of euros: the format cannot carry a million or more. */
export const MAX_BARCODE_CENTS = 999_999_99;

export interface BarcodeInput {
  iban: string;
  reference: string;
  amountCents: number;
  /** Invoice due date; omitted or null renders as 000000. */
  dueDate?: Date | string | null;
}

export interface DecodedBarcode {
  version: string;
  iban: string;
  amountCents: number;
  reference: string;
  dueDate: string | null;
}

function dueDateDigits(value: Date | string | null | undefined): string {
  if (!value) return "000000";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "000000";
  const year = String(date.getUTCFullYear() % 100).padStart(2, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

/** Returns null when the payment cannot be expressed as a version-4 barcode. */
export function buildBankBarcode(input: BarcodeInput): string | null {
  const iban = normalizeIban(input.iban ?? "");
  if (!iban.startsWith("FI") || !isValidIban(iban)) return null;

  const reference = normalizeReference(input.reference ?? "");
  // RF references belong to version 5, and an invalid reference must never be
  // encoded into something a bank would accept.
  if (!isValidReferenceNumber(reference)) return null;
  if (reference.length > 20) return null;

  if (!Number.isSafeInteger(input.amountCents) || input.amountCents < 0) return null;
  if (input.amountCents > MAX_BARCODE_CENTS) return null;

  const euros = String(Math.floor(input.amountCents / 100)).padStart(6, "0");
  const cents = String(input.amountCents % 100).padStart(2, "0");

  const barcode =
    "4" +
    iban.slice(2) +
    euros +
    cents +
    "000" +
    reference.padStart(20, "0") +
    dueDateDigits(input.dueDate);

  return barcode.length === BARCODE_LENGTH ? barcode : null;
}

/** Inverse of buildBankBarcode; used to verify what was encoded. */
export function decodeBankBarcode(barcode: string): DecodedBarcode | null {
  const digits = barcode.replace(/\s/g, "");
  if (!/^\d{54}$/.test(digits) || digits[0] !== "4") return null;

  const iban = `FI${digits.slice(1, 17)}`;
  const amountCents = Number(digits.slice(17, 23)) * 100 + Number(digits.slice(23, 25));
  const reference = digits.slice(28, 48).replace(/^0+(?=\d)/, "");
  const due = digits.slice(48, 54);

  return {
    version: digits[0],
    iban,
    amountCents,
    reference,
    dueDate:
      due === "000000"
        ? null
        : `20${due.slice(0, 2)}-${due.slice(2, 4)}-${due.slice(4, 6)}`,
  };
}

/** Human-readable grouping used under the barcode on printed invoices. */
export function formatBankBarcode(barcode: string): string {
  return barcode.replace(/(.{6})(?=.)/g, "$1 ");
}

/** Why an invoice gets no barcode, in words the owner can act on; null when it gets one. */
export function barcodeIssue(input: { iban: string | null | undefined; reference: string; amountCents: number }): string | null {
  const iban = normalizeIban(input.iban ?? "");
  if (!iban) return "Lisää yrityksen tilinumero (IBAN) asetuksiin, niin laskuun tulee virtuaaliviivakoodi.";
  if (!iban.startsWith("FI")) return "Virtuaaliviivakoodi tehdään vain suomalaiselle tilinumerolle (FI).";
  if (!isValidIban(iban)) return "Tarkista yrityksen tilinumero (IBAN) asetuksista.";
  const reference = normalizeReference(input.reference ?? "");
  if (/^RF/i.test(reference)) return "RF-viitteelle ei tehdä virtuaaliviivakoodia; maksaja syöttää viitteen käsin.";
  if (!isValidReferenceNumber(reference)) return "Laskun viitenumero ei kelpaa virtuaaliviivakoodiin.";
  if (input.amountCents > MAX_BARCODE_CENTS) return "Yli 999 999,99 euron summaa ei voi esittää virtuaaliviivakoodina.";
  return buildBankBarcode({ iban, reference, amountCents: input.amountCents }) ? null : "Virtuaaliviivakoodia ei voitu muodostaa.";
}
