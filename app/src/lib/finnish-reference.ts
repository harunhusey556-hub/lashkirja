/**
 * Finnish reference numbers (viitenumero) and business IDs (Y-tunnus).
 *
 * A payment carrying the invoice's reference is matched by the bank row alone,
 * which is what makes automatic sales-invoice reconciliation possible. Both
 * check digits are computed for real - a typo must fail here, not at the bank.
 */

/** Weights 7-3-1 repeating from the right, check digit completes to the next ten. */
export function referenceCheckDigit(base: string): number {
  if (!/^\d+$/.test(base)) throw new RangeError("Reference base must be digits only");
  const weights = [7, 3, 1];
  let sum = 0;
  let index = 0;
  for (let position = base.length - 1; position >= 0; position -= 1) {
    sum += Number(base[position]) * weights[index % 3];
    index += 1;
  }
  return (10 - (sum % 10)) % 10;
}

/**
 * Domestic reference: 3-19 digit base plus the check digit (4-20 total).
 * Leading zeros are kept - they do not change the check digit (they carry
 * weight 0) but they are part of what the invoice prints.
 */
export function createReferenceNumber(base: string | number): string {
  const digits = String(base).replace(/\D/g, "");
  if (digits.length < 3) {
    throw new RangeError("Reference base must be 3-19 digits");
  }
  if (digits.length > 19) {
    throw new RangeError("Reference base may have at most 19 digits");
  }
  if (/^0+$/.test(digits)) {
    throw new RangeError("Reference base must contain a non-zero digit");
  }
  return `${digits}${referenceCheckDigit(digits)}`;
}

export function normalizeReference(value: string): string {
  return value.replace(/\s/g, "");
}

export function isValidReferenceNumber(value: string | null | undefined): boolean {
  if (!value) return false;
  const normalized = normalizeReference(value);
  if (!/^\d{4,20}$/.test(normalized)) return false;
  if (/^0+$/.test(normalized)) return false;
  const base = normalized.slice(0, -1);
  const check = Number(normalized.slice(-1));
  return referenceCheckDigit(base) === check;
}

/** Banks print references in groups of five, counted from the right. */
export function formatReference(value: string): string {
  const normalized = normalizeReference(value);
  const groups: string[] = [];
  for (let end = normalized.length; end > 0; end -= 5) {
    groups.unshift(normalized.slice(Math.max(0, end - 5), end));
  }
  return groups.join(" ");
}

/**
 * A stable reference for an invoice number. The prefix separates users sharing
 * a bank account's payment stream; it is optional and always numeric.
 */
export function referenceForInvoice(invoiceNumber: number, prefix = ""): string {
  const cleanPrefix = prefix.replace(/\D/g, "");
  if (!Number.isSafeInteger(invoiceNumber) || invoiceNumber <= 0) {
    throw new RangeError("Invoice number must be a positive integer");
  }
  // Pad so short invoice numbers still reach the 3-digit minimum base.
  const base = `${cleanPrefix}${String(invoiceNumber).padStart(3, "0")}`;
  return createReferenceNumber(base);
}

const BUSINESS_ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2];

export function normalizeBusinessId(value: string): string {
  const digits = value.replace(/[^0-9]/g, "");
  if (digits.length !== 8) return value.trim().toUpperCase();
  return `${digits.slice(0, 7)}-${digits.slice(7)}`;
}

/** Y-tunnus: 7 digits, weighted mod 11, remainder 1 is unusable by definition. */
export function isValidBusinessId(value: string | null | undefined): boolean {
  if (!value) return false;
  const match = /^(\d{7})-(\d)$/.exec(normalizeBusinessId(value));
  if (!match) return false;
  const body = match[1];
  const check = Number(match[2]);
  const sum = BUSINESS_ID_WEIGHTS.reduce(
    (total, weight, index) => total + weight * Number(body[index]),
    0
  );
  const remainder = sum % 11;
  if (remainder === 1) return false;
  const expected = remainder === 0 ? 0 : 11 - remainder;
  return expected === check;
}
