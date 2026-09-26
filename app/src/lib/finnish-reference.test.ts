import { describe, expect, it } from "vitest";
import {
  createReferenceNumber,
  formatReference,
  isValidBusinessId,
  isValidReferenceNumber,
  normalizeBusinessId,
  referenceCheckDigit,
  referenceForInvoice,
} from "./finnish-reference";

describe("referenceCheckDigit", () => {
  it("matches known bank examples", () => {
    // 1234561 is the canonical example from the Finance Finland guide.
    expect(referenceCheckDigit("123456")).toBe(1);
    expect(referenceCheckDigit("1234")).toBe(4);
    expect(referenceCheckDigit("100")).toBe(9);
  });

  it("rejects non-digit input instead of coercing", () => {
    expect(() => referenceCheckDigit("12a4")).toThrow(RangeError);
    expect(() => referenceCheckDigit("")).toThrow(RangeError);
  });

  it("always returns a single digit", () => {
    for (let n = 100; n < 400; n += 1) {
      const digit = referenceCheckDigit(String(n));
      expect(digit).toBeGreaterThanOrEqual(0);
      expect(digit).toBeLessThanOrEqual(9);
    }
  });
});

describe("createReferenceNumber", () => {
  it("appends the check digit", () => {
    expect(createReferenceNumber("123456")).toBe("1234561");
    expect(createReferenceNumber(1234)).toBe("12344");
  });

  it("keeps leading zeros, which do not affect the check digit", () => {
    expect(createReferenceNumber("000123456")).toBe("0001234561");
    expect(isValidReferenceNumber("0001234561")).toBe(true);
  });

  it("enforces the 3..19 digit base", () => {
    expect(() => createReferenceNumber("12")).toThrow(RangeError);
    expect(() => createReferenceNumber("0".repeat(5))).toThrow(RangeError);
    expect(() => createReferenceNumber("00")).toThrow(RangeError);
    expect(() => createReferenceNumber("1".repeat(20))).toThrow(RangeError);
    expect(createReferenceNumber("1".repeat(19))).toHaveLength(20);
  });

  it("produces references that validate", () => {
    for (const base of ["123", "999999", "5551234", "1234567890123456789"]) {
      expect(isValidReferenceNumber(createReferenceNumber(base)), base).toBe(true);
    }
  });
});

describe("isValidReferenceNumber", () => {
  it("accepts spaced references", () => {
    expect(isValidReferenceNumber("12 34561")).toBe(true);
  });

  it("catches a single wrong digit", () => {
    expect(isValidReferenceNumber("1234562")).toBe(false);
    expect(isValidReferenceNumber("1234571")).toBe(false);
  });

  it("catches transposed digits", () => {
    // A 7-3-1 weighting does not catch every transposition, but this pair it does.
    expect(isValidReferenceNumber("1234561")).toBe(true);
    expect(isValidReferenceNumber("2134561")).toBe(false);
  });

  it("rejects out-of-range lengths, zeros and junk", () => {
    for (const bad of ["", "123", "0000", "1".repeat(21), "abc1", "12-3456"]) {
      expect(isValidReferenceNumber(bad), bad).toBe(false);
    }
    expect(isValidReferenceNumber(null)).toBe(false);
    expect(isValidReferenceNumber(undefined)).toBe(false);
  });
});

describe("formatReference", () => {
  it("groups by five from the right", () => {
    expect(formatReference("1234561")).toBe("12 34561");
    expect(formatReference("1234512345")).toBe("12345 12345");
    expect(formatReference("12345")).toBe("12345");
  });

  it("is reversible through normalisation", () => {
    const reference = createReferenceNumber("987654321");
    expect(formatReference(reference).replace(/\s/g, "")).toBe(reference);
  });
});

describe("referenceForInvoice", () => {
  it("produces a valid, stable reference per invoice number", () => {
    const first = referenceForInvoice(1);
    expect(first).toBe(referenceForInvoice(1));
    expect(isValidReferenceNumber(first)).toBe(true);
  });

  it("keeps short invoice numbers legal by padding the base", () => {
    expect(isValidReferenceNumber(referenceForInvoice(7))).toBe(true);
    expect(referenceForInvoice(7).length).toBeGreaterThanOrEqual(4);
  });

  it("separates users through the numeric prefix", () => {
    expect(referenceForInvoice(12, "9")).not.toBe(referenceForInvoice(12, "8"));
    expect(isValidReferenceNumber(referenceForInvoice(12, "42"))).toBe(true);
  });

  it("ignores non-numeric prefix characters", () => {
    expect(referenceForInvoice(12, "AB9")).toBe(referenceForInvoice(12, "9"));
  });

  it("rejects invalid invoice numbers", () => {
    expect(() => referenceForInvoice(0)).toThrow(RangeError);
    expect(() => referenceForInvoice(-3)).toThrow(RangeError);
    expect(() => referenceForInvoice(1.5)).toThrow(RangeError);
  });

  it("never collides for consecutive invoice numbers", () => {
    const seen = new Set<string>();
    for (let n = 1; n <= 500; n += 1) seen.add(referenceForInvoice(n));
    expect(seen.size).toBe(500);
  });
});

describe("Y-tunnus", () => {
  it("accepts real business IDs", () => {
    // Both check digits verified against the mod-11 algorithm.
    expect(isValidBusinessId("0201256-6")).toBe(true);
    expect(isValidBusinessId("2454577-7")).toBe(true);
  });

  it("accepts an unformatted 8-digit string", () => {
    expect(isValidBusinessId("02012566")).toBe(true);
    expect(normalizeBusinessId("02012566")).toBe("0201256-6");
  });

  it("rejects a wrong check digit", () => {
    expect(isValidBusinessId("0201256-5")).toBe(false);
  });

  it("rejects malformed values", () => {
    for (const bad of ["", "123456-7", "12345678-9", "abcdefg-1", "0201256"]) {
      expect(isValidBusinessId(bad), bad).toBe(false);
    }
    expect(isValidBusinessId(null)).toBe(false);
  });

  it("rejects the remainder-1 case that has no valid check digit", () => {
    // Body 1000008 gives sum % 11 === 1, so no check digit can be correct.
    for (let digit = 0; digit <= 9; digit += 1) {
      expect(isValidBusinessId(`1000008-${digit}`)).toBe(false);
    }
  });
});
